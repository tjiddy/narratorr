import type { DiscoveredBook } from '@/lib/api';

/** Keep Library Import visibility and eligibility on one predicate; Manual Import has a different trust boundary. */
export function isLibraryDbDuplicate(book: DiscoveredBook): boolean {
  return book.isDuplicate;
}
