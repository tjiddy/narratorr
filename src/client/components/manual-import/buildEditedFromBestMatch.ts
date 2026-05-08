import type { BookMetadata } from '@/lib/api';
import type { BookEditState } from './types.js';

/**
 * Maps an Audnexus best-match result onto a BookEditState row, falling back to
 * the row's existing fields when the metadata omits them. Shared by both
 * Manual Import and Library Import auto-match merge paths so future
 * ImportConfirmItem fields stay in sync between the two hooks.
 */
export function buildEditedFromBestMatch(bestMatch: BookMetadata, fallback: BookEditState): BookEditState {
  const mergedSeriesPosition = bestMatch.series?.[0]?.position ?? fallback.seriesPosition;
  return {
    title: bestMatch.title,
    author: bestMatch.authors?.[0]?.name ?? fallback.author,
    series: bestMatch.series?.[0]?.name ?? fallback.series,
    ...(bestMatch.narrators?.length && { narrators: bestMatch.narrators }),
    ...(mergedSeriesPosition !== undefined && { seriesPosition: mergedSeriesPosition }),
    ...(bestMatch.coverUrl !== undefined && { coverUrl: bestMatch.coverUrl }),
    ...(bestMatch.asin !== undefined && { asin: bestMatch.asin }),
    metadata: bestMatch,
  };
}
