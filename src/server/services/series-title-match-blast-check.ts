/**
 * One-off pre-merge blast check for the #2096 matcher rebuild.
 *
 *   pnpm exec tsx src/server/services/series-title-match-blast-check.ts [dbPath]
 *
 * Replays the PRE-#2096 pairing (colon-truncating scalar normalizer, scalar
 * equality) and the POST-#2096 pairing (title-variant sets, asymmetric
 * acceptance rule) over the live library × cached `series_members`, and prints
 * every member whose outcome moved.
 *
 * TWO position modes, both required, reported for every scope below:
 *
 *   1. FULL — positions exactly as stored. This is what users actually see.
 *   2. TITLE-PATH ONLY — every position forced to null on both sides, so the
 *      position pass can never fire. Position rescue masks title-path
 *      regressions: a member that used to pair by title and now does not still
 *      shows "unchanged" in mode 1 whenever the positions happen to agree.
 *      Mode 2 is the one that can actually see a title-path regression.
 *
 * THREE candidate scopes, because production does NOT use one pool. Reporting a
 * single canonical-name pool would omit exactly the stale-name books the changed
 * matcher processes on the bind path — the `Dune Chronicles` → `Dune` shape the
 * Chapterhouse case is made of:
 *
 *   A. RENDER — `books.series_name = series.name`. The `buildCardFromCache`
 *      scope (`series-card.service.ts`, via `loadLibraryBooksForSeries`).
 *   B. BIND — `books.series_name IN (series.name, ...observed prior names)`.
 *      Production's bind passes `[resolved.name, priorSeriesName]` into
 *      `persistMembers` (`series-card.service.ts:410-413`). `priorSeriesName` is
 *      a runtime value, so it is reconstructed statically as the distinct
 *      `books.series_name` values carried by books ALREADY LINKED to this series
 *      row (`series_members.book_id`) — a book linked to the row while still
 *      holding an older name IS the pre-bind population.
 *   C. LIBRARY-WIDE — every book with a non-null `series_name`, matched against
 *      every series' members. A strict SUPERSET of any pool production can build,
 *      including a future bind whose `priorSeriesName` is not yet observable in
 *      the data (an unlinked book still carrying a name nothing points at). This
 *      scope is what makes the sweep unable to MISS a pair; it over-reports
 *      rather than under-reports, so its extra rows are noise to triage, not
 *      regressions. B is the honest reconstruction; C is the safety net.
 *
 * Read-only: opens the DB, runs SELECTs, writes nothing.
 */

import { existsSync } from 'fs';
import { eq } from 'drizzle-orm';
import { createDb } from '@db/index.js';
import { books, series, seriesMembers } from '@db/schema.js';
import {
  findInLibraryMatch,
  type HardcoverMemberSummary,
  type LibraryBookSummary,
} from './series-title-match.js';

// ─── The pre-#2096 pairing, replicated verbatim ──────────────────────────────

/** The pre-#2096 scalar normalizer: TRUNCATES at the first colon, strips all parens/brackets. */
function legacyNormalize(title: string): string {
  let stripped = title
    .replace(/[’‘]/g, "'")
    .replace(/\(\s*(?:unabridged|audio|audible)\s*\)/gi, ' ')
    .replace(/\[\s*(?:unabridged|audio|audible)\s*\]/gi, ' ');
  const colonIdx = stripped.indexOf(':');
  if (colonIdx >= 0) stripped = stripped.slice(0, colonIdx);
  stripped = stripped.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  return stripped
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const POSITION_EPSILON = 1e-9;

function legacyPositionsMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < POSITION_EPSILON;
}

function legacyFindInLibraryMatch(
  member: HardcoverMemberSummary,
  candidates: LibraryBookSummary[],
  alreadyMatched: ReadonlySet<number>,
): LibraryBookSummary | null {
  const memberNormalized = legacyNormalize(member.title);
  for (const candidate of candidates) {
    if (alreadyMatched.has(candidate.id)) continue;
    if (legacyPositionsMatch(member.position, candidate.seriesPosition)) return candidate;
  }
  if (memberNormalized.length === 0) return null;
  for (const candidate of candidates) {
    if (alreadyMatched.has(candidate.id)) continue;
    if (legacyNormalize(candidate.title) === memberNormalized) return candidate;
  }
  return null;
}

// ─── Diffing ─────────────────────────────────────────────────────────────────

type Outcome = 'newly-paired' | 'unpaired' | 'repaired' | 'unchanged';

interface Row {
  seriesName: string;
  memberTitle: string;
  memberPosition: number | null;
  before: string | null;
  after: string | null;
  outcome: Outcome;
}

function classify(before: number | null, after: number | null): Outcome {
  if (before === after) return 'unchanged';
  if (before === null) return 'newly-paired';
  if (after === null) return 'unpaired';
  return 'repaired';
}

/**
 * Pair every member of every series both ways. `ignorePositions` nulls all
 * positions so only the title path can fire.
 */
function diffSeries(
  members: HardcoverMemberSummary[],
  candidates: LibraryBookSummary[],
  seriesName: string,
  ignorePositions: boolean,
): Row[] {
  const pool = ignorePositions
    ? candidates.map((c) => ({ ...c, seriesPosition: null }))
    : candidates;
  const claimedBefore = new Set<number>();
  const claimedAfter = new Set<number>();
  const rows: Row[] = [];

  for (const raw of members) {
    const member = ignorePositions ? { ...raw, position: null } : raw;
    const before = legacyFindInLibraryMatch(member, pool, claimedBefore);
    if (before) claimedBefore.add(before.id);
    const after = findInLibraryMatch(member, pool, claimedAfter);
    if (after) claimedAfter.add(after.id);

    const outcome = classify(before?.id ?? null, after?.id ?? null);
    if (outcome === 'unchanged') continue;
    rows.push({
      seriesName,
      memberTitle: raw.title,
      memberPosition: raw.position,
      before: before?.title ?? null,
      after: after?.title ?? null,
      outcome,
    });
  }
  return rows;
}

function report(label: string, rows: Row[], memberCount: number, poolSize: number): void {
  const counts: Record<Outcome, number> = { 'newly-paired': 0, unpaired: 0, repaired: 0, unchanged: 0 };
  for (const row of rows) counts[row.outcome]++;
  counts.unchanged = memberCount - rows.length;

  console.log(`\n=== ${label} ===`);
  console.log(`members: ${memberCount}  candidate-slots: ${poolSize}  newly-paired: ${counts['newly-paired']}  unpaired: ${counts.unpaired}  repaired: ${counts.repaired}  unchanged: ${counts.unchanged}`);
  if (rows.length === 0) {
    console.log('  (no outcome changed)');
    return;
  }
  // Unpairings first — those are the ones that need a named justification.
  const order: Outcome[] = ['unpaired', 'repaired', 'newly-paired'];
  for (const outcome of order) {
    for (const row of rows.filter((r) => r.outcome === outcome)) {
      console.log(
        `  [${row.outcome}] ${row.seriesName} | member "${row.memberTitle}" (pos ${row.memberPosition ?? 'null'}) | before: ${row.before ?? '—'} | after: ${row.after ?? '—'}`,
      );
    }
  }
}

/** The three candidate scopes, in widening order. See the module header. */
const SCOPES = ['render', 'bind', 'library-wide'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = {
  render: 'A. RENDER scope — books.series_name = series.name (buildCardFromCache)',
  bind: 'B. BIND scope — canonical + observed prior names (persistMembers extraSeriesNames)',
  'library-wide': 'C. LIBRARY-WIDE scope — every series-bearing book (strict superset)',
};

interface Accumulator {
  full: Row[];
  titleOnly: Row[];
  poolSize: number;
}

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? process.env.DATABASE_PATH ?? './config/narratorr.db';
  // libsql happily CREATES a missing file, which would turn "I pointed this at
  // the wrong path" into a silent all-zeroes report — the one failure mode that
  // makes a blast check actively misleading. Refuse instead.
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Point this at the live library, e.g.\n  pnpm exec tsx ${process.argv[1]} /path/to/config/narratorr.db`);
    process.exitCode = 1;
    return;
  }
  console.log(`#2096 pairing blast check over ${dbPath}`);
  const db = createDb(dbPath);

  const seriesRows = await db.select().from(series);
  const allBooks = await db
    .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition, seriesName: books.seriesName })
    .from(books);
  // Scope C: every book carrying a series name. A `seriesName`-tombstoned book
  // has `series_name = NULL` and SQL `IN` never matches it, so production can
  // never pool one — excluding them keeps the superset faithful rather than
  // inventing candidates production cannot see.
  const libraryWide = allBooks.filter((b) => b.seriesName !== null);

  const acc: Record<Scope, Accumulator> = {
    render: { full: [], titleOnly: [], poolSize: 0 },
    bind: { full: [], titleOnly: [], poolSize: 0 },
    'library-wide': { full: [], titleOnly: [], poolSize: 0 },
  };
  let memberCount = 0;

  for (const row of seriesRows) {
    const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row.id));
    if (memberRows.length === 0) continue;
    const members = memberRows.map((m) => ({ title: m.title, position: m.position }));

    // Scope B's prior names: the distinct series names carried by books ALREADY
    // LINKED to this row. A linked book still holding an older name is exactly
    // the population `priorSeriesName` pulls in on the bind path.
    const linkedIds = new Set(memberRows.map((m) => m.bookId).filter((id): id is number => id !== null));
    const priorNames = new Set(
      allBooks
        .filter((b) => linkedIds.has(b.id) && b.seriesName !== null && b.seriesName !== row.name)
        .map((b) => b.seriesName as string),
    );
    const bindNames = new Set<string>([row.name, ...priorNames]);

    const pools: Record<Scope, LibraryBookSummary[]> = {
      render: libraryWide.filter((b) => b.seriesName === row.name),
      bind: libraryWide.filter((b) => bindNames.has(b.seriesName as string)),
      'library-wide': libraryWide,
    };

    memberCount += members.length;
    for (const scope of SCOPES) {
      const pool = pools[scope];
      acc[scope].poolSize += pool.length;
      if (pool.length === 0) continue;
      acc[scope].full.push(...diffSeries(members, pool, row.name, false));
      acc[scope].titleOnly.push(...diffSeries(members, pool, row.name, true));
    }

    if (priorNames.size > 0) {
      console.log(`  note: series "${row.name}" has linked books on prior name(s): ${[...priorNames].join(', ')}`);
    }
  }

  if (memberCount === 0) {
    console.log('\nNo cached series members found — nothing to diff.');
  }
  for (const scope of SCOPES) {
    console.log(`\n──────── ${SCOPE_LABEL[scope]} ────────`);
    report('FULL outcome diff (positions as stored)', acc[scope].full, memberCount, acc[scope].poolSize);
    report('TITLE-PATH-ONLY diff (all positions ignored)', acc[scope].titleOnly, memberCount, acc[scope].poolSize);
  }

  db.$client.close();
}

await main();
