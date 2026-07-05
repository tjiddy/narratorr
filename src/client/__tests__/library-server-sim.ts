// Test-only simulation of the server's library status-filter behavior.
//
// The production library page sends status/sort/collapse to the server as query
// params (`useLibraryFilters` → `/api/library/books`), so the client no longer
// filters or sorts in-process. The `LibraryPage` test harnesses reproduce the
// server's *status bucket* filter inside their `listLibraryBooks` mock via this
// helper, which reads the same shared `LIBRARY_FILTER_BUCKETS` constant the
// server's `BUCKET_EXPANSION` uses — so it is not a reimplementation.
//
// Server *sort* order is deliberately NOT re-derived here (that would duplicate
// `BookListService.buildOrderBy` and silently drift). The mocks look the order
// up from hand-authored, pre-ordered fixtures instead — see the LibraryPage
// test files.
import type { StatusFilter } from '@/pages/library/helpers';
import { LIBRARY_FILTER_BUCKETS } from '../../shared/schemas/book.js';

/** Does a book status fall in the given filter bucket? Mirrors the server's stat buckets. */
export function simulateStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return (LIBRARY_FILTER_BUCKETS[filter] as readonly string[]).includes(status);
}
