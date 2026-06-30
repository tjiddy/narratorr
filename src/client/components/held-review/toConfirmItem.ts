import type { ImportConfirmItem } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import';

/**
 * Build the confirm payload for a row. `force` (or an existing duplicate flag)
 * sets `forceImport` so the server bypasses the recording-identity safety-net —
 * used both for user-selected duplicates and for re-confirming a held-review item.
 */
export function toConfirmItem(r: ImportRow, force: boolean): ImportConfirmItem {
  return {
    path: r.book.path,
    title: r.edited.title,
    ...(r.edited.author && { authorName: r.edited.author }),
    ...(r.edited.series && { seriesName: r.edited.series }),
    ...(r.edited.narrators?.length && { narrators: r.edited.narrators }),
    ...(r.edited.seriesPosition !== undefined && { seriesPosition: r.edited.seriesPosition }),
    ...(r.edited.coverUrl !== undefined && { coverUrl: r.edited.coverUrl }),
    ...(r.edited.asin !== undefined && { asin: r.edited.asin }),
    ...(r.edited.metadata !== undefined && { metadata: r.edited.metadata }),
    ...(force || r.book.isDuplicate ? { forceImport: true } : {}),
  };
}
