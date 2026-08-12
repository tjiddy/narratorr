import type { HardcoverClient, HardcoverSearchCandidate, HardcoverSeriesData } from '@core/metadata/hardcover.js';
import { diceCoefficient } from '@core/utils/similarity.js';

export const AUTHOR_OVERLAP_WEIGHT = 0.6;
export const NAME_SIM_WEIGHT = 0.4;
export const SCORE_THRESHOLD = 0.5;
export const AUTHOR_OVERLAP_THRESHOLD = 0.5;

const NORMALIZABLE_SUFFIXES = [' series', ' trilogy', ' saga', ' novella'];

/**
 * Normalize Hardcover/Audible drift by removing leading articles and series suffixes in addition
 * to punctuation and whitespace folding.
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
 * Score 60% author overlap and 40% name similarity, with independent gates on both. Break ties
 * by book count, then lower Hardcover id.
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
  seriesName: string;
  author: string;
}

/**
 * Resolve by exact name/author, normalized exact match, then gated search scoring. Return null
 * when all three miss.
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
  // Re-fetch the winner so callers receive canonical members, not the search envelope.
  const members = await client.getSeriesMembersById(best.id);
  return members;
}
