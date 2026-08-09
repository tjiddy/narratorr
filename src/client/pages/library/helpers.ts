import { resolveBookQualityInputs } from '@core/utils/index.js';
import type { LibraryBookListItem } from '@/lib/api';
import {
  LIBRARY_FILTER_VALUES,
  type LibraryFilterValue,
} from '@shared/schemas/book.js';

export type StatusFilter = LibraryFilterValue;
export type SortField = 'createdAt' | 'title' | 'author' | 'narrator' | 'series' | 'quality' | 'size' | 'format';
export type SortDirection = 'asc' | 'desc';

export type DisplayBook = LibraryBookListItem;

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  wanted: 'Wanted',
  downloading: 'Downloading',
  imported: 'Imported',
  failed: 'Failed',
  missing: 'Missing',
};

/** Derive tab order and membership from the server's canonical filter vocabulary. */
export const filterTabs: { key: StatusFilter; label: string }[] = LIBRARY_FILTER_VALUES.map(
  (key) => ({ key, label: FILTER_LABELS[key] }),
);

/** Compute MB/hour after normalizing byte and duration units. */
export function computeMbPerHour(book: LibraryBookListItem): number | null {
  const { sizeBytes, durationSeconds } = resolveBookQualityInputs(book);
  if (!sizeBytes || !durationSeconds) return null;
  const mb = sizeBytes / (1024 * 1024);
  const hours = durationSeconds / 3600;
  return mb / hours;
}
