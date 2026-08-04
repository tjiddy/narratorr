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
 * Candidate pools are replayed ONE PRODUCTION POOL AT A TIME. Production never
 * builds a single global pool, and a global pool cannot stand in for the real
 * ones: both matchers are ordered, first-claim-wins greedy algorithms, so an
 * unrelated book that sorts earlier in a wider pool can be claimed identically by
 * BOTH versions and mask a delta that the real, narrower pool would expose. A
 * superset over-reports AND under-reports here; it is not a safety net, so this
 * script does not use one.
 *
 *   RENDER — `books.series_name = series.name`, the `buildCardFromCache` pool
 *     (`series-card.service.ts`, via `loadLibraryBooksForSeries`). One pool per
 *     series.
 *
 *   BIND(P) — `books.series_name IN (series.name, P)`, replayed SEPARATELY for
 *     each plausible prior name P, with P reported alongside every row. This is
 *     the exact shape production builds: `bindHardcoverSeries` reads
 *     `priorSeriesName` from the initiating book at `series-card.service.ts:389`
 *     and passes `[resolved.name, priorSeriesName]` — canonical plus exactly ONE
 *     prior name — into `persistMembers` at line 413.
 *
 * Deriving P from `series_members.book_id` (books already linked to the row) is
 * WRONG and was this script's earlier defect: linkage is an OUTPUT of the bind,
 * not an input. `relinkBookToBoundSeries` runs at line 440, AFTER `persistMembers`
 * has already matched, so the initiating book is typically UNLINKED while it is
 * being matched — which is precisely the Chapterhouse shape (a book on
 * `Dune Chronicles` with no member row, bound to the canonical `Dune`).
 *
 * P is instead derived by REACHABILITY: the distinct `books.series_name` values
 * (excluding the canonical) of every book that either matcher could actually
 * return for some member of this series. The pruning is sound rather than
 * heuristic — a book neither matcher can ever return is never claimed, so it can
 * neither produce a delta nor mask one, in any pool containing it.
 *
 * Read-only: opens the DB, runs SELECTs, writes nothing.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { asc, eq } from 'drizzle-orm';
import { createDb, type Db } from '@db/index.js';
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
  /** The one prior name this pool added, or null for the RENDER pool. */
  priorName: string | null;
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
  priorName: string | null,
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
      priorName,
      memberTitle: raw.title,
      memberPosition: raw.position,
      before: before?.title ?? null,
      after: after?.title ?? null,
      outcome,
    });
  }
  return rows;
}

function report(label: string, rows: Row[], pairings: number, pools: number): void {
  const counts: Record<Outcome, number> = { 'newly-paired': 0, unpaired: 0, repaired: 0, unchanged: 0 };
  for (const row of rows) counts[row.outcome]++;
  counts.unchanged = pairings - rows.length;

  console.log(`\n=== ${label} ===`);
  console.log(`pools: ${pools}  member-pairings: ${pairings}  newly-paired: ${counts['newly-paired']}  unpaired: ${counts.unpaired}  repaired: ${counts.repaired}  unchanged: ${counts.unchanged}`);
  if (rows.length === 0) {
    console.log('  (no outcome changed)');
    return;
  }
  // Unpairings first — those are the ones that need a named justification.
  const order: Outcome[] = ['unpaired', 'repaired', 'newly-paired'];
  for (const outcome of order) {
    for (const row of rows.filter((r) => r.outcome === outcome)) {
      const pool = row.priorName === null ? 'render' : `bind +"${row.priorName}"`;
      console.log(
        `  [${row.outcome}] ${row.seriesName} [${pool}] | member "${row.memberTitle}" (pos ${row.memberPosition ?? 'null'}) | before: ${row.before ?? '—'} | after: ${row.after ?? '—'}`,
      );
    }
  }
}

/** The two production pool shapes. See the module header. */
const SCOPES = ['render', 'bind'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = {
  render: 'RENDER pools — books.series_name = series.name (buildCardFromCache)',
  bind: 'BIND pools — books.series_name IN (canonical, ONE prior name), replayed per prior name',
};

interface Accumulator {
  full: Row[];
  titleOnly: Row[];
  /** Number of (series, pool) replays — a bind series contributes one per prior name. */
  pools: number;
  /** Number of member×pool pairings evaluated; the denominator for `unchanged`. */
  pairings: number;
}

/**
 * Can either matcher ever return `candidate` for `member`? Used to prune the
 * prior-name search space. Sound, not heuristic: a candidate no matcher can
 * return is never claimed, so it cannot produce a delta or mask one in ANY pool
 * that contains it. Both matchers are consulted because the arms differ — the
 * point is to keep a book that only the NEW matcher can reach.
 */
function reachable(member: HardcoverMemberSummary, candidate: LibraryBookSummary): boolean {
  const solo = [candidate];
  if (legacyFindInLibraryMatch(member, solo, new Set()) !== null) return true;
  if (findInLibraryMatch(member, solo, new Set()) !== null) return true;
  // Title-path reachability too: a shared position is not required for a pool to
  // matter, and the positions-ignored mode below runs with every position nulled.
  const blind = { ...member, position: null };
  const blindSolo = [{ ...candidate, seriesPosition: null }];
  return (
    legacyFindInLibraryMatch(blind, blindSolo, new Set()) !== null
    || findInLibraryMatch(blind, blindSolo, new Set()) !== null
  );
}

/**
 * A replay candidate — production's projection plus the `series_name` the pools
 * filter on.
 *
 * `seriesName` is NON-NULLABLE by construction, and that is a postcondition of
 * `loadReplayCandidates` rather than of the column: a `seriesName`-tombstoned
 * book stores `series_name = NULL`, SQL `IN` never matches one, so production
 * can never pool it and the loader drops it. Encoding the guarantee in the type
 * — instead of carrying `string | null` and casting at each use site — is what
 * makes tombstone exclusion part of this module's API rather than a comment.
 */
export interface ReplayCandidate extends LibraryBookSummary {
  seriesName: string;
}

/**
 * The replay's ENTIRE candidate universe, in production's pinned order. Every
 * pool below is a `.filter()` of this list, and `Array.prototype.filter`
 * preserves order, so pinning it here pins every replayed pool.
 *
 * `ORDER BY books.id`, matching the order production pins (#2108 —
 * `loadLibraryBooksForSeriesNames` carries the same `asc(books.id)`), so each
 * replayed pool presents candidates in the same sequence production's
 * `WHERE series_name IN (…)` would. Load-bearing, because both matchers are
 * first-claim-wins within a match-quality tier. Before #2108 both sides were
 * unordered, which agreed only by planner accident; the replay must track
 * production's contract, or its whole premise (replayed pool order equals
 * production's) is false — and a blast check whose pools differ from
 * production's reports planner-dependent deltas that production never sees.
 *
 * A `seriesName`-tombstoned book has `series_name = NULL` and SQL `IN` never
 * matches it, so production can never pool one; they are dropped here.
 *
 * EXPORTED for `series-title-match-blast-check.test.ts`, which is the only
 * executable signal on that ordering contract — the forced-index integration
 * fixture observes production's loader, not this one.
 */
export async function loadReplayCandidates(db: Db): Promise<ReplayCandidate[]> {
  const allBooks = await db
    .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition, seriesName: books.seriesName })
    .from(books)
    .orderBy(asc(books.id));
  // A type PREDICATE, not a bare boolean: it is what carries the non-null
  // guarantee out to `ReplayCandidate` so no caller has to assert it back.
  return allBooks.filter((b): b is ReplayCandidate => b.seriesName !== null);
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
  const named = await loadReplayCandidates(db);

  const acc: Record<Scope, Accumulator> = {
    render: { full: [], titleOnly: [], pools: 0, pairings: 0 },
    bind: { full: [], titleOnly: [], pools: 0, pairings: 0 },
  };

  const replay = (scope: Scope, members: HardcoverMemberSummary[], pool: LibraryBookSummary[], seriesName: string, priorName: string | null): void => {
    if (pool.length === 0) return;
    acc[scope].pools += 1;
    acc[scope].pairings += members.length;
    acc[scope].full.push(...diffSeries(members, pool, seriesName, priorName, false));
    acc[scope].titleOnly.push(...diffSeries(members, pool, seriesName, priorName, true));
  };

  for (const row of seriesRows) {
    const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row.id));
    if (memberRows.length === 0) continue;
    const members = memberRows.map((m) => ({ title: m.title, position: m.position }));

    const canonicalPool = named.filter((b) => b.seriesName === row.name);
    replay('render', members, canonicalPool, row.name, null);

    // Prior names, derived by REACHABILITY rather than by linkage — linkage is an
    // output of the bind (`relinkBookToBoundSeries`, series-card.service.ts:440),
    // so the initiating book is typically still unlinked while it is matched.
    const priorNames = new Set(
      named
        .filter((b) => b.seriesName !== row.name && members.some((m) => reachable(m, b)))
        .map((b) => b.seriesName),
    );

    // One pool per prior name — canonical + exactly ONE extra, the shape
    // `bindHardcoverSeries` builds. Never all prior names at once, and never a
    // global pool: a wider pool lets an earlier unrelated book be claimed by both
    // matcher versions and mask a delta the real pool would show.
    for (const priorName of priorNames) {
      const bindPool = named.filter((b) => b.seriesName === row.name || b.seriesName === priorName);
      replay('bind', members, bindPool, row.name, priorName);
    }

    if (priorNames.size > 0) {
      console.log(`  note: series "${row.name}" — replaying ${priorNames.size} bind pool(s) for prior name(s): ${[...priorNames].map((n) => `"${n}"`).join(', ')}`);
    }
  }

  if (acc.render.pools === 0 && acc.bind.pools === 0) {
    console.log('\nNo cached series members with library candidates found — nothing to diff.');
  }
  for (const scope of SCOPES) {
    console.log(`\n──────── ${SCOPE_LABEL[scope]} ────────`);
    report('FULL outcome diff (positions as stored)', acc[scope].full, acc[scope].pairings, acc[scope].pools);
    report('TITLE-PATH-ONLY diff (all positions ignored)', acc[scope].titleOnly, acc[scope].pairings, acc[scope].pools);
  }

  db.$client.close();
}

// CLI entry point — only when run directly via `tsx <this file>`, mirroring
// `src/db/migrate.ts`. The ordering drift guard imports this module for
// `loadReplayCandidates`, and an unguarded top-level `await main()` would run
// the whole replay on import — which, with no live library at the default path,
// also sets `process.exitCode = 1` and would fail the entire vitest run. No
// `isBundled` companion check is needed here: nothing imports this module from
// the server, so tsup (entry `src/server/index.ts`) never inlines it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
