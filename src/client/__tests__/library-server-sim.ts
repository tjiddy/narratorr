// Reuses shared status buckets to mimic server filtering. Sort fixtures stay
// hand-ordered to avoid duplicating BookListService.buildOrderBy.
import type { StatusFilter } from '@/pages/library/helpers';
import { LIBRARY_FILTER_BUCKETS } from '@shared/schemas/book.js';

export function simulateStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return (LIBRARY_FILTER_BUCKETS[filter] as readonly string[]).includes(status);
}
