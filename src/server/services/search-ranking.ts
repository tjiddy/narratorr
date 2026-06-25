import { calculateQuality } from '../../core/utils/index.js';
import { narratorsFuzzyMatch } from '../../core/utils/similarity.js';
import type { SearchResult } from '../../core/index.js';

/** Optional narrator-priority config for auto-grab scoring. */
export interface NarratorPriority {
  bookNarrators: string[];
  /**
   * Test-only seam (#1650/#1652): overrides the `0.8` dice threshold passed
   * through to `narratorsFuzzyMatch`. `buildNarratorPriority` never assigns it
   * in production, so the default always applies at runtime — it exists purely
   * so `similarity.test.ts` can exercise the exact-boundary and relaxed-bar
   * cases. Do NOT drop it as dead code.
   */
  threshold?: number;
}

const NARRATOR_QUALITY_FLOOR_MBHR = 30;

/**
 * Check whether a search result's narrator fuzzy-matches any of the book's narrators.
 * Delegates to the shared `narratorsFuzzyMatch` primitive (#1650) so the fuzzy
 * cross-product and the `0.8` default threshold live in exactly one place.
 */
function isNarratorMatch(result: SearchResult, priority: NarratorPriority): boolean {
  return narratorsFuzzyMatch(result.narrator, priority.bookNarrators, priority.threshold);
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
