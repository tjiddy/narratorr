import { toSortTitle } from '@narratorr/core/utils';
import type { BookWithAuthor } from '@/lib/api';

export type StatusFilter = 'all' | 'wanted' | 'downloading' | 'imported';
export type SortField = 'createdAt' | 'title' | 'author';
export type SortDirection = 'asc' | 'desc';

export interface DisplayBook extends BookWithAuthor {
  collapsedCount?: number;
}

export const filterTabs: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'wanted', label: 'Wanted' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'imported', label: 'Imported' },
];


export function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'wanted') return status === 'wanted';
  if (filter === 'downloading') return status === 'searching' || status === 'downloading';
  if (filter === 'imported') return status === 'imported' || status === 'importing';
  return false;
}

export function getStatusCount(books: BookWithAuthor[], filter: StatusFilter): number {
  return books.filter((b) => matchesStatusFilter(b.status, filter)).length;
}

export function sortBooks<T extends BookWithAuthor>(books: T[], field: SortField, direction: SortDirection): T[] {
  return [...books].sort((a, b) => {
    let cmp = 0;
    if (field === 'title') {
      cmp = toSortTitle(a.title).localeCompare(toSortTitle(b.title));
    } else if (field === 'author') {
      cmp = (a.author?.name ?? '').localeCompare(b.author?.name ?? '');
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    return direction === 'asc' ? cmp : -cmp;
  });
}

export function collapseSeries(
  books: BookWithAuthor[],
  sortField: SortField,
  sortDirection: SortDirection,
): DisplayBook[] {
  const seriesGroups = new Map<string, BookWithAuthor[]>();
  const standalones: DisplayBook[] = [];

  for (const book of books) {
    if (book.seriesName) {
      const group = seriesGroups.get(book.seriesName);
      if (group) {
        group.push(book);
      } else {
        seriesGroups.set(book.seriesName, [book]);
      }
    } else {
      standalones.push(book);
    }
  }

  const collapsed: DisplayBook[] = [...standalones];

  for (const [, group] of seriesGroups) {
    // Pick representative: lowest seriesPosition among visible books
    const withPosition = group.filter((b) => b.seriesPosition != null);
    let representative: BookWithAuthor;
    if (withPosition.length > 0) {
      representative = withPosition.reduce((best, b) =>
        b.seriesPosition! < best.seriesPosition! ? b : best,
      );
    } else {
      // Fallback: first by current sort order
      const sorted = sortBooks(group, sortField, sortDirection);
      representative = sorted[0];
    }
    collapsed.push({
      ...representative,
      collapsedCount: group.length - 1,
    });
  }

  return collapsed;
}
