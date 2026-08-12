import type { BookMetadata } from '@/lib/api';
import type { BookEditState } from './types.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

/** Keeps Manual Import and Library Import best-match merging aligned. */
export function buildEditedFromBestMatch(bestMatch: BookMetadata, fallback: BookEditState): BookEditState {
  // Audible series[0] can be a broader universe; prefer the canonical primary series.
  const primary = pickPrimarySeries(bestMatch);
  const mergedSeriesPosition = primary?.position ?? fallback.seriesPosition;
  return {
    title: bestMatch.title,
    author: bestMatch.authors?.[0]?.name ?? fallback.author,
    series: primary?.name ?? fallback.series,
    ...(bestMatch.narrators?.length && { narrators: bestMatch.narrators }),
    ...(mergedSeriesPosition !== undefined && { seriesPosition: mergedSeriesPosition }),
    ...(bestMatch.coverUrl !== undefined && { coverUrl: bestMatch.coverUrl }),
    ...(bestMatch.asin !== undefined && { asin: bestMatch.asin }),
    metadata: bestMatch,
  };
}
