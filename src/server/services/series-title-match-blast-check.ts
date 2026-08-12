/**
 * One-off read-only matcher blast check: `pnpm exec tsx ... [dbPath]`.
 * Compare pre/post #2096 pairings in full and position-null modes; positions can mask title regressions.
 * Replay each production pool separately because greedy first-claim matching makes global supersets lie.
 * RENDER is one canonical series pool; BIND(P) is canonical plus exactly one prior name.
 * Derive P from candidates either matcher can reach, never `series_members` linkage (a bind output).
 * STALE since #2175 changed pool normalization; rework before rerunning.
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

/** Pre-#2096 normalization truncates at the first colon and strips all parentheses/brackets. */
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

type Outcome = 'newly-paired' | 'unpaired' | 'repaired' | 'unchanged';

interface Row {
  seriesName: string;
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

/** `ignorePositions` isolates title matching by nulling both sides. */
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
  // Report unpairings first because each needs explicit justification.
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

const SCOPES = ['render', 'bind'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = {
  render: 'RENDER pools — books.series_name = series.name (buildCardFromCache)',
  bind: 'BIND pools — books.series_name IN (canonical, ONE prior name), replayed per prior name',
};

interface Accumulator {
  full: Row[];
  titleOnly: Row[];
  pools: number;
  pairings: number;
}

/**
 * Consult both matchers when pruning prior names. An unreachable candidate cannot be claimed,
 * produce a delta, or mask one.
 */
function reachable(member: HardcoverMemberSummary, candidate: LibraryBookSummary): boolean {
  const solo = [candidate];
  if (legacyFindInLibraryMatch(member, solo, new Set()) !== null) return true;
  if (findInLibraryMatch(member, solo, new Set()) !== null) return true;
  // Check title-only reachability because the second report nulls every position.
  const blind = { ...member, position: null };
  const blindSolo = [{ ...candidate, seriesPosition: null }];
  return (
    legacyFindInLibraryMatch(blind, blindSolo, new Set()) !== null
    || findInLibraryMatch(blind, blindSolo, new Set()) !== null
  );
}

/** The loader drops NULL `series_name` rows, which production's SQL `IN` cannot pool. */
export interface ReplayCandidate extends LibraryBookSummary {
  seriesName: string;
}

/**
 * Load the full universe in production's `books.id` order; filtered pools preserve this order.
 * Ordering is load-bearing because both matchers are greedy first-claim-wins (#2108).
 * Exported so the dedicated test can guard this loader rather than production's separate loader.
 */
export async function loadReplayCandidates(db: Db): Promise<ReplayCandidate[]> {
  const allBooks = await db
    .select({ id: books.id, title: books.title, seriesPosition: books.seriesPosition, seriesName: books.seriesName })
    .from(books)
    .orderBy(asc(books.id));
  return allBooks.filter((b): b is ReplayCandidate => b.seriesName !== null);
}

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? process.env.DATABASE_PATH ?? './config/narratorr.db';
  // libsql creates missing files, so refuse a misleading all-zeroes report.
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

    // Derive prior names by reachability; linkage is a bind output and is usually absent here.
    const priorNames = new Set(
      named
        .filter((b) => b.seriesName !== row.name && members.some((m) => reachable(m, b)))
        .map((b) => b.seriesName),
    );

    // Replay canonical plus one prior name; a wider greedy pool can mask real deltas.
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

// The ordering test imports this module; run the CLI only when invoked directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
