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
 * TWO diffs, both required:
 *
 *   1. FULL — positions exactly as stored. This is what users actually see.
 *   2. TITLE-PATH ONLY — every position forced to null on both sides, so the
 *      position pass can never fire. Position rescue masks title-path
 *      regressions: a member that used to pair by title and now does not still
 *      shows "unchanged" in diff 1 whenever the positions happen to agree.
 *      Diff 2 is the one that can actually see a title-path regression.
 *
 * Read-only: opens the DB, runs SELECTs, writes nothing.
 *
 * Candidate scoping approximates production, which scopes to the initiating
 * book's `books.series_name` (plus the pre-bind name on the bind path). Here the
 * scope is the canonical `series.name`, which is that same value for every
 * already-bound series and errs toward a SMALLER candidate pool — so a pairing
 * this script reports is a pairing production would also find.
 */

import { eq, inArray } from 'drizzle-orm';
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

function report(label: string, rows: Row[], memberCount: number): void {
  const counts: Record<Outcome, number> = { 'newly-paired': 0, unpaired: 0, repaired: 0, unchanged: 0 };
  for (const row of rows) counts[row.outcome]++;
  counts.unchanged = memberCount - rows.length;

  console.log(`\n=== ${label} ===`);
  console.log(`members: ${memberCount}  newly-paired: ${counts['newly-paired']}  unpaired: ${counts.unpaired}  repaired: ${counts.repaired}  unchanged: ${counts.unchanged}`);
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

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? process.env.DATABASE_PATH ?? './config/narratorr.db';
  console.log(`#2096 pairing blast check over ${dbPath}`);
  const db = createDb(dbPath);

  const seriesRows = await db.select().from(series);
  const fullRows: Row[] = [];
  const titleOnlyRows: Row[] = [];
  let memberCount = 0;

  for (const row of seriesRows) {
    const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row.id));
    if (memberRows.length === 0) continue;
    const candidates = await db
      .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition })
      .from(books)
      .where(inArray(books.seriesName, [row.name]));
    if (candidates.length === 0) continue;

    const members = memberRows.map((m) => ({ title: m.title, position: m.position }));
    memberCount += members.length;
    fullRows.push(...diffSeries(members, candidates, row.name, false));
    titleOnlyRows.push(...diffSeries(members, candidates, row.name, true));
  }

  if (memberCount === 0) {
    console.log('\nNo cached series members with library candidates found — nothing to diff.');
  }
  report('FULL outcome diff (positions as stored)', fullRows, memberCount);
  report('TITLE-PATH-ONLY diff (all positions ignored)', titleOnlyRows, memberCount);

  db.$client.close();
}

await main();
