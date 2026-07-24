import type { ImportConfirmItem } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import';

/**
 * Build the confirm payload for a row. `force` (or an existing duplicate flag)
 * sets `forceImport` so the server bypasses the recording-identity safety-net —
 * used both for user-selected duplicates and for re-confirming a held-review item.
 */
export function toConfirmItem(r: ImportRow, force: boolean): ImportConfirmItem {
  // Two-state, pair-locked series mapping (#1927 AC5): classify by trim, but emit
  // the ORIGINAL (untrimmed) series value. A non-empty edited series emits
  // `seriesName` plus its paired `seriesPosition`; an empty/whitespace-only series
  // OMITS BOTH so the server defers to the matched metadata's primary (narrator
  // parity). Position never ships without a series. This mirrors the authoritative
  // server-side resolver — here it is an early UX safeguard for a clean wire payload.
  const seriesPresent = r.edited.series.trim().length > 0;
  return {
    path: r.book.path,
    title: r.edited.title,
    ...(r.edited.author && { authorName: r.edited.author }),
    ...(seriesPresent && { seriesName: r.edited.series }),
    ...(r.edited.narrators?.length && { narrators: r.edited.narrators }),
    ...(seriesPresent && r.edited.seriesPosition !== undefined && { seriesPosition: r.edited.seriesPosition }),
    ...(r.edited.coverUrl !== undefined && { coverUrl: r.edited.coverUrl }),
    ...(r.edited.asin !== undefined && { asin: r.edited.asin }),
    ...(r.edited.metadata !== undefined && { metadata: r.edited.metadata }),
    ...(force || r.book.isDuplicate ? { forceImport: true } : {}),
  };
}
