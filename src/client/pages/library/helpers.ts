import { toSortTitle } from '../../../core/utils/index.js';
import type { BookWithAuthor } from '@/lib/api';

export type StatusFilter = 'all' | 'wanted' | 'downloading' | 'imported';
export type SortField = 'createdAt' | 'title' | 'author' | 'narrator' | 'series' | 'quality' | 'size' | 'format';
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

/** Split a narrator string on comma, semicolon, or ampersand delimiters. */
export function extractNarrators(narrator: string | null | undefined): string[] {
  if (!narrator || narrator.trim() === '') return [];
  const names = narrator.split(/[,;&]/).map((n) => n.trim()).filter(Boolean);
  // Deduplicate case-insensitively, keeping first occurrence
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(name);
    }
  }
  return unique;
}

/** Compute MB per hour from size (bytes) and duration (seconds). */
export function computeMbPerHour(book: BookWithAuthor): number | null {
  const duration = book.audioDuration ?? book.duration;
  if (!duration || duration <= 0) return null;
  const size = book.audioTotalSize ?? book.size;
  if (!size) return null;
  const mb = size / (1024 * 1024);
  const hours = duration / 3600;
  return mb / hours;
}

/** Get the effective size for sorting — audioTotalSize with fallback to size. */
function getEffectiveSize(book: BookWithAuthor): number | null {
  return book.audioTotalSize ?? book.size ?? null;
}

/** Null-safe comparison: nulls sort last regardless of direction. */
function compareNullable(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return (a as number) - (b as number);
}

const fieldExtractors: Record<string, (book: BookWithAuthor) => string | number | null> = {
  title: (b) => toSortTitle(b.title),
  author: (b) => b.author?.name ?? '',
  narrator: (b) => b.narrator ?? null,
  series: (b) => b.seriesName ?? null,
  quality: (b) => computeMbPerHour(b),
  size: (b) => getEffectiveSize(b),
  format: (b) => b.audioFileFormat ?? null,
  createdAt: (b) => new Date(b.createdAt).getTime(),
};

function compareByField(a: BookWithAuthor, b: BookWithAuthor, field: SortField): number {
  const extract = fieldExtractors[field] ?? fieldExtractors.createdAt;
  return compareNullable(extract(a), extract(b));
}

export function sortBooks<T extends BookWithAuthor>(books: T[], field: SortField, direction: SortDirection): T[] {
  return [...books].sort((a, b) => {
    const cmp = compareByField(a, b, field);
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
