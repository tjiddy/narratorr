import type { HardcoverClient, HardcoverSearchCandidate, HardcoverSeriesData } from '../../core/metadata/hardcover.js';
import { diceCoefficient } from '../../core/utils/similarity.js';

export const AUTHOR_OVERLAP_WEIGHT = 0.6;
export const NAME_SIM_WEIGHT = 0.4;
export const SCORE_THRESHOLD = 0.5;
export const AUTHOR_OVERLAP_THRESHOLD = 0.5;

const NORMALIZABLE_SUFFIXES = [' series', ' trilogy', ' saga', ' novella'];

/**
 * Normalize a Hardcover series name (or library `seriesName`) for the
 * step-2 normalized equality compare. Preserves alphanumerics with single
 * spaces, strips a leading `the `, strips trailing series/trilogy/saga/novella
 * markers, and folds curly apostrophes. Different from the DB-level
 * `normalizeSeriesName` because it removes article + suffix markers — those
 * are the empirical drift patterns Hardcover and Audible disagree on.
 */
export function normalizeSeriesNameForResolver(name: string): string {
  let normalized = name
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.startsWith('the ')) normalized = normalized.slice(4);
  for (const suffix of NORMALIZABLE_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim();
      break;
    }
  }
  return normalized;
}

/**
 * Tokenize an author name for overlap scoring: lowercase, strip terminal
 * punctuation, split on whitespace, drop empties. Tokens stay as-is (no
 * stemming) because we compare set membership, not similarity.
 */
export function tokenizeAuthor(name: string): Set<string> {
  const cleaned = name
    .toLowerCase()
    .replace(/[.,'’‘\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return new Set();
  return new Set(cleaned.split(' ').filter((t) => t.length > 0));
}

/** Author-overlap score: |L ∩ R| / max(|L|, |R|). Returns 0 when either side is empty. */
export function computeAuthorOverlap(libraryAuthor: string, candidateAuthor: string): number {
  const left = tokenizeAuthor(libraryAuthor);
  const right = tokenizeAuthor(candidateAuthor);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const t of left) if (right.has(t)) intersection++;
  return intersection / Math.max(left.size, right.size);
}

interface ScoredCandidate {
  candidate: HardcoverSearchCandidate;
  score: number;
  authorOverlap: number;
}

const SCORE_TIE_EPSILON = 1e-4;

function scoreCandidate(libraryName: string, libraryAuthor: string, candidate: HardcoverSearchCandidate): ScoredCandidate {
  const authorName = candidate.authorName ?? '';
  const authorOverlap = computeAuthorOverlap(libraryAuthor, authorName);
  const nameSim = diceCoefficient(libraryName, candidate.name);
  const score = AUTHOR_OVERLAP_WEIGHT * authorOverlap + NAME_SIM_WEIGHT * nameSim;
  return { candidate, score, authorOverlap };
}

/**
 * Pick the best Hardcover series candidate per the spec's scoring formula:
 * `0.6 * authorOverlap + 0.4 * nameSim`. Drops anything below
 * `SCORE_THRESHOLD` OR `AUTHOR_OVERLAP_THRESHOLD` (the double gate prevents a
 * high name-sim from rescuing a weak author match). Tie-breakers: higher
 * books_count first, then lower Hardcover id (deterministic).
 */
export function pickBestSearchCandidate(
  libraryName: string,
  libraryAuthor: string,
  candidates: HardcoverSearchCandidate[],
): HardcoverSearchCandidate | null {
  const eligible: HardcoverSearchCandidate[] = candidates.filter((c) => c.booksCount > 0 && c.authorName && c.authorName.length > 0);
  if (eligible.length === 0) return null;
  const scored = eligible.map((c) => scoreCandidate(libraryName, libraryAuthor, c));
  const passing = scored.filter((s) => s.score >= SCORE_THRESHOLD && s.authorOverlap >= AUTHOR_OVERLAP_THRESHOLD);
  if (passing.length === 0) return null;
  passing.sort((a, b) => {
    if (Math.abs(a.score - b.score) > SCORE_TIE_EPSILON) return b.score - a.score;
    if (a.candidate.booksCount !== b.candidate.booksCount) return b.candidate.booksCount - a.candidate.booksCount;
    return a.candidate.id - b.candidate.id;
  });
  return passing[0]!.candidate;
}

export interface ResolverOptions {
  /** Series name from the local library (`books.series_name`). */
  seriesName: string;
  /** Primary author of the seed book. */
  author: string;
}

/**
 * Three-step disambiguation chain (see issue spec):
 *   1. Exact `name + author { name } _eq` on Hardcover.
 *   2. Normalize both inputs (strip leading `The `, trailing series/trilogy
 *      /saga/novella, fold curly apostrophes) and retry exact `_eq`.
 *   3. Hardcover `search` API fallback: scored top-10 candidates against
 *      `0.6 * authorOverlap + 0.4 * nameSim`, gated by both thresholds.
 *
 * Returns the resolved Hardcover series data on success, or null when no
 * step produces a match.
 */
export async function resolveSeriesViaHardcover(
  client: HardcoverClient,
  opts: ResolverOptions,
): Promise<HardcoverSeriesData | null> {
  const exact = await client.getSeriesMembers(opts.seriesName, opts.author);
  if (exact) return exact;

  const normalizedName = normalizeSeriesNameForResolver(opts.seriesName);
  const normalizedAuthor = opts.author.replace(/[’‘]/g, "'");
  if (
    normalizedName.length > 0
    && (normalizedName !== opts.seriesName.toLowerCase() || normalizedAuthor !== opts.author)
  ) {
    const normalized = await client.getSeriesMembers(normalizedName, normalizedAuthor);
    if (normalized) return normalized;
  }

  const candidates = await client.searchSeries(normalizedName || opts.seriesName);
  const best = pickBestSearchCandidate(opts.seriesName, opts.author, candidates);
  if (!best) return null;
  // Re-fetch the picked candidate's members via the cached-id query so the
  // resolved object carries the canonical member list, not just the search
  // candidate's lightweight envelope.
  const members = await client.getSeriesMembersById(best.id);
  return members;
}
