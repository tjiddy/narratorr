import { calculateQuality } from '../../core/utils/index.js';
import { diceCoefficient, tokenizeNarrators, normalizeNarrator } from '../../core/utils/similarity.js';
import type { SearchResult } from '../../core/index.js';

/** Optional narrator-priority config for auto-grab scoring. */
export interface NarratorPriority {
  bookNarrators: string[];
  threshold?: number;
}

const NARRATOR_MATCH_THRESHOLD = 0.8;
const NARRATOR_QUALITY_FLOOR_MBHR = 30;

/**
 * Check whether a search result's narrator fuzzy-matches any of the book's narrators.
 * Returns true if the best pairwise diceCoefficient >= threshold.
 */
function isNarratorMatch(result: SearchResult, priority: NarratorPriority): boolean {
  if (!result.narrator) return false;
  const threshold = priority.threshold ?? NARRATOR_MATCH_THRESHOLD;
  const resultTokens = tokenizeNarrators(result.narrator).map(normalizeNarrator).filter(Boolean);
  if (resultTokens.length === 0) return false;
  const bookNormalized = priority.bookNarrators.map(normalizeNarrator).filter(Boolean);
  if (bookNormalized.length === 0) return false;
  let best = 0;
  for (const rt of resultTokens) {
    for (const bn of bookNormalized) {
      best = Math.max(best, diceCoefficient(rt, bn));
    }
  }
  return best >= threshold;
}

/**
 * Compute the narrator-match tier value for a result.
 * Returns 1 for boosted (narrator match above quality floor), 0 otherwise.
 */
function narratorTierValue(
  result: SearchResult,
  priority: NarratorPriority | undefined,
  bookDuration: number | undefined,
  durationUnknown: boolean,
): number {
  if (!priority || priority.bookNarrators.length === 0) return 0;
  if (!isNarratorMatch(result, priority)) return 0;
  if (!durationUnknown && result.size && result.size > 0) {
    const quality = calculateQuality(result.size, bookDuration!);
    if (quality && quality.mbPerHour < NARRATOR_QUALITY_FLOOR_MBHR) return 0;
  }
  return 1;
}

/**
 * Canonical ranking comparator:
 * matchScore gate → narrator match → MB/hr → protocol preference → language → indexer priority → grabs → seeders.
 */
// eslint-disable-next-line complexity -- multi-tier sort with null coalescing inflates counted branches
export function canonicalCompare(
  a: SearchResult,
  b: SearchResult,
  bookDuration: number | undefined,
  durationUnknown: boolean,
  protocolPreference: string,
  languages: readonly string[],
  narratorPriority?: NarratorPriority,
): number {
  const scoreA = a.matchScore ?? 0;
  const scoreB = b.matchScore ?? 0;
  const scoreDiff = scoreB - scoreA;

  if (Math.abs(scoreDiff) > 0.1) return scoreDiff;

  // Narrator-match tier (only when narratorPriority is provided)
  if (narratorPriority && narratorPriority.bookNarrators.length > 0) {
    const nA = narratorTierValue(a, narratorPriority, bookDuration, durationUnknown);
    const nB = narratorTierValue(b, narratorPriority, bookDuration, durationUnknown);
    if (nA !== nB) return nB - nA;
  }

  if (!durationUnknown) {
    const qualA = (a.size && a.size > 0) ? calculateQuality(a.size, bookDuration!) : null;
    const qualB = (b.size && b.size > 0) ? calculateQuality(b.size, bookDuration!) : null;
    const mbhrA = qualA?.mbPerHour ?? -1;
    const mbhrB = qualB?.mbPerHour ?? -1;
    if (mbhrA !== mbhrB) return mbhrB - mbhrA;
  }

  if (protocolPreference !== 'none') {
    const prefA = a.protocol === protocolPreference ? 1 : 0;
    const prefB = b.protocol === protocolPreference ? 1 : 0;
    if (prefA !== prefB) return prefB - prefA;
  }

  // Language tier: mismatch ranks below match/unknown (absence ≠ mismatch)
  // Sub-tier: primary language (first entry) ranks above other matches
  if (languages.length > 0) {
    const primary = languages[0];
    const aLang = a.language?.toLowerCase();
    const bLang = b.language?.toLowerCase();
    const aMatch = !aLang || languages.includes(aLang) ? 1 : 0;
    const bMatch = !bLang || languages.includes(bLang) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    // Among matches, prefer primary language
    if (aMatch === 1 && bMatch === 1 && languages.length > 1) {
      const aPrimary = aLang === primary ? 1 : 0;
      const bPrimary = bLang === primary ? 1 : 0;
      if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    }
  }

  // Indexer priority tier: lower value = more preferred (ascending)
  const prioA = a.indexerPriority ?? Infinity;
  const prioB = b.indexerPriority ?? Infinity;
  if (prioA !== prioB) return prioA - prioB;

  // Grabs tier: log-scale normalization
  const grabsA = Math.log10((a.grabs ?? 0) + 1);
  const grabsB = Math.log10((b.grabs ?? 0) + 1);
  if (grabsA !== grabsB) return grabsB - grabsA;

  return (b.seeders ?? 0) - (a.seeders ?? 0);
}
