import type { DiscoveredBook } from '@/lib/api';

/**
 * The single library-import DB-duplicate decision (#1833). A book is a DB-backed
 * duplicate (already in the library by path or slug) when it is flagged `isDuplicate`
 * for a reason OTHER than `within-scan` — a within-scan collision is two folders in the
 * same scan, not something already owned, so it stays actionable.
 *
 * This decision drives BOTH selection/counts/pending/retry-match eligibility (the hook)
 * AND row visibility/the "N new" denominator (the page). They MUST agree or the UI lies
 * about importability when `duplicateReason` grows a case, so both sites call this one
 * predicate rather than re-deriving it (the DRY-3 twin-drift class).
 *
 * NOTE: Manual import intentionally uses a different predicate (`row.book.isDuplicate`
 * directly) — a different trust boundary — and must NOT be unified with this.
 */
export function isLibraryDbDuplicate(book: DiscoveredBook): boolean {
  return book.isDuplicate && book.duplicateReason !== 'within-scan';
}
