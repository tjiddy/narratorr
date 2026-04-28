import { resolveBookQualityInputs, toSortTitle } from '@core/utils/index.js';
import type { BookWithAuthor } from '@/lib/api';

export type StatusFilter = 'all' | 'wanted' | 'downloading' | 'imported' | 'failed' | 'missing';
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
  { key: 'failed', label: 'Failed' },
  { key: 'missing', label: 'Missing' },
];


export function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'wanted') return status === 'wanted';
  if (filter === 'downloading') return status === 'searching' || status === 'downloading';
  if (filter === 'imported') return status === 'imported' || status === 'importing';
  if (filter === 'failed') return status === 'failed';
  if (filter === 'missing') return status === 'missing';
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

/** Compute MB per hour from size (bytes) and duration. Delegates unit handling to resolveBookQualityInputs (audioDuration in seconds, duration in minutes). */
export function computeMbPerHour(book: BookWithAuthor): number | null {
  const { sizeBytes, durationSeconds } = resolveBookQualityInputs(book);
  if (!sizeBytes || !durationSeconds) return null;
  const mb = sizeBytes / (1024 * 1024);
  const hours = durationSeconds / 3600;
  return mb / hours;
}

/** Get the effective size for sorting — audioTotalSize with fallback to size. */
function getEffectiveSize(book: BookWithAuthor): number | null {
  return book.audioTotalSize ?? book.size ?? null;
}

/**
 * Compare two nullable values. Returns:
 * - `{ nullResult: number }` when at least one value is null (nulls sort last, direction-independent)
 * - `{ valueResult: number }` when both values are non-null (caller applies direction)
 */
function compareNullable(a: string | number | null, b: string | number | null): { nullResult: number } | { valueResult: number } {
  if (a === null && b === null) return { nullResult: 0 };
  if (a === null) return { nullResult: 1 };
  if (b === null) return { nullResult: -1 };
  if (typeof a === 'string' && typeof b === 'string') return { valueResult: a.localeCompare(b) };
  return { valueResult: (a as number) - (b as number) };
}

const fieldExtractors: Record<string, (book: BookWithAuthor) => string | number | null> = {
  title: (b) => toSortTitle(b.title),
  author: (b) => b.authors?.[0]?.name ?? '',
  narrator: (b) => b.narrators?.[0]?.name ?? null,
  series: (b) => b.seriesName ?? null,
  quality: (b) => computeMbPerHour(b),
  size: (b) => getEffectiveSize(b),
  format: (b) => b.audioFileFormat ?? null,
  createdAt: (b) => new Date(b.createdAt).getTime(),
};

function compareByField(a: BookWithAuthor, b: BookWithAuthor, field: SortField, direction: SortDirection): number {
  const extract = fieldExtractors[field] ?? fieldExtractors.createdAt;
  const result = compareNullable(extract(a), extract(b));
  if ('nullResult' in result) return result.nullResult;
  return direction === 'asc' ? result.valueResult : -result.valueResult;
}

export function sortBooks<T extends BookWithAuthor>(books: T[], field: SortField, direction: SortDirection): T[] {
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

  // Re-sort collapsed result so series groups interleave correctly with standalones.
  // For title sorts, collapsed items use seriesName (the visible label) as the sort key.
  return sortCollapsed(collapsed, sortField, sortDirection);
}

/** Sort collapsed display books, using seriesName for title-sorted collapsed groups. */
function sortCollapsed(books: DisplayBook[], field: SortField, direction: SortDirection): DisplayBook[] {
  const extract = (b: DisplayBook): string | number | null => {
    if (field === 'title' && b.collapsedCount != null && b.seriesName) {
      return toSortTitle(b.seriesName);
    }
    return (fieldExtractors[field] ?? fieldExtractors.createdAt)(b);
  };

  return [...books].sort((a, b) => {
    const result = compareNullable(extract(a), extract(b));
    if ('nullResult' in result) return result.nullResult;
    const cmp = direction === 'asc' ? result.valueResult : -result.valueResult;
    if (cmp !== 0) return cmp;
    // Stable tiebreaker by id
    const idCmp = a.id - b.id;
    return direction === 'asc' ? idCmp : -idCmp;
  });
}

