import type { BookWithAuthor } from '@/lib/api';

export type StatusFilter = 'all' | 'wanted' | 'downloading' | 'imported';
export type SortField = 'createdAt' | 'title' | 'author';
export type SortDirection = 'asc' | 'desc';

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

export function sortBooks(books: BookWithAuthor[], field: SortField, direction: SortDirection): BookWithAuthor[] {
  return [...books].sort((a, b) => {
    let cmp = 0;
    if (field === 'title') {
      cmp = a.title.localeCompare(b.title);
    } else if (field === 'author') {
      cmp = (a.author?.name ?? '').localeCompare(b.author?.name ?? '');
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    return direction === 'asc' ? cmp : -cmp;
  });
}
