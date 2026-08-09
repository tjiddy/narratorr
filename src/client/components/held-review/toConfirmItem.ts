import type { ImportConfirmItem } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import';

/** `forceImport` bypasses recording checks for explicit duplicates and held-review retries. */
export function toConfirmItem(r: ImportRow, force: boolean): ImportConfirmItem {
  // Series fields are paired: whitespace omits both; otherwise preserve the original
  // text and include a position only when a series is present.
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
