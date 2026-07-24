import type { DiscoveredBook } from '@/lib/api';

/**
 * The single library-import DB-duplicate decision (#1833). A book is a DB-backed
 * duplicate (already in the library by path or slug) exactly when it is flagged
 * `isDuplicate` — both remaining duplicate reasons (`path`/`slug`) are DB-backed.
 * (Within-scan title collisions are no longer hard-flagged as of #1925: they flow
 * through as normal candidates and the confirm-time recording ladder decides
 * identity, so there is no longer a non-DB `isDuplicate` reason to special-case.)
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
  return book.isDuplicate;
}
