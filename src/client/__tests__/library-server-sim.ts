// Test-only simulation of the server's library filter/sort behavior.
//
// The production library page sends status/sort/collapse to the server as query
// params (`useLibraryFilters` → `/api/library/books`), so the client no longer
// filters or sorts in-process. The `LibraryPage` test harnesses still need to
// reproduce that server behavior inside their `listLibraryBooks` mock — these
// helpers port the (now server-owned) filter and sort logic for that purpose.
import { toSortTitle } from '@core/utils/index.js';
import { computeMbPerHour } from '@/pages/library/helpers';
import type { StatusFilter, SortField, SortDirection } from '@/pages/library/helpers';
import type { LibraryBookListItem } from '@/lib/api';
import { LIBRARY_FILTER_BUCKETS } from '../../shared/schemas/book.js';

/** Does a book status fall in the given filter bucket? Mirrors the server's stat buckets. */
export function simulateStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return (LIBRARY_FILTER_BUCKETS[filter] as readonly string[]).includes(status);
}

function getEffectiveSize(book: LibraryBookListItem): number | null {
  return book.audioTotalSize ?? book.size ?? null;
}

function compareNullable(a: string | number | null, b: string | number | null): { nullResult: number } | { valueResult: number } {
  if (a === null && b === null) return { nullResult: 0 };
  if (a === null) return { nullResult: 1 };
  if (b === null) return { nullResult: -1 };
  if (typeof a === 'string' && typeof b === 'string') return { valueResult: a.localeCompare(b) };
  return { valueResult: (a as number) - (b as number) };
}

const fieldExtractors: Record<SortField, (book: LibraryBookListItem) => string | number | null> = {
  title: (b) => toSortTitle(b.title),
  author: (b) => b.authors?.[0]?.name ?? '',
  narrator: (b) => b.narrators?.[0]?.name ?? null,
  series: (b) => b.seriesName ?? null,
  quality: (b) => computeMbPerHour(b),
  size: (b) => getEffectiveSize(b),
  format: (b) => b.audioFileFormat ?? null,
  createdAt: (b) => new Date(b.createdAt).getTime(),
};

function compareByField(a: LibraryBookListItem, b: LibraryBookListItem, field: SortField, direction: SortDirection): number {
  const extract = fieldExtractors[field] ?? fieldExtractors.createdAt;
  const result = compareNullable(extract(a), extract(b));
  if ('nullResult' in result) return result.nullResult;
  return direction === 'asc' ? result.valueResult : -result.valueResult;
}

/** Stable sort mirroring the server's list ordering (nulls last, series position tiebreaker). */
export function simulateServerSort<T extends LibraryBookListItem>(books: T[], field: SortField, direction: SortDirection): T[] {
  return [...books].sort((a, b) => {
    const cmp = compareByField(a, b, field, direction);
    if (cmp !== 0 || field !== 'series') return cmp;
    // Position tiebreaker only within a named series — no-series books skip to id fallback
    if (a.seriesName != null && b.seriesName != null) {
      const posResult = compareNullable(a.seriesPosition ?? null, b.seriesPosition ?? null);
      if ('nullResult' in posResult) { if (posResult.nullResult !== 0) return posResult.nullResult; }
      else if (posResult.valueResult !== 0) return posResult.valueResult;
    }
    // Direction-matched id fallback for equal/null positions
    const idCmp = a.id - b.id;
    return direction === 'asc' ? idCmp : -idCmp;
  });
}
