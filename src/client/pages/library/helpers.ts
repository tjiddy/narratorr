import { resolveBookQualityInputs } from '@core/utils/index.js';
import type { LibraryBookListItem } from '@/lib/api';
import {
  LIBRARY_FILTER_VALUES,
  type LibraryFilterValue,
} from '../../../shared/schemas/book.js';

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

/** Dropdown tabs derived from the canonical filter vocabulary — order and
 *  membership track `LIBRARY_FILTER_VALUES`, so the client can never offer a
 *  bucket the server doesn't count. */
export const filterTabs: { key: StatusFilter; label: string }[] = LIBRARY_FILTER_VALUES.map(
  (key) => ({ key, label: FILTER_LABELS[key] }),
);

/** Compute MB per hour from size (bytes) and duration. Delegates unit handling to resolveBookQualityInputs (audioDuration in seconds, duration in minutes). */
export function computeMbPerHour(book: LibraryBookListItem): number | null {
  const { sizeBytes, durationSeconds } = resolveBookQualityInputs(book);
  if (!sizeBytes || !durationSeconds) return null;
  const mb = sizeBytes / (1024 * 1024);
  const hours = durationSeconds / 3600;
  return mb / hours;
}
