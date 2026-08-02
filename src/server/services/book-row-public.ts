import type { BookRow, BookRowPublic } from './types.js';

/**
 * Drop the raw `user_cleared_fields` text from a whole-row `books` select (#2069 AC16).
 *
 * Call this at every seam where a book row becomes part of an HTTP response. The
 * leak this prevents is a runtime object key, not a type error: the affected
 * routes (`GET /api/activity`, `/activity/active`, `/activity/:id`, the retry
 * `201`, `POST /api/search/grab`) declare no response schema, so nothing strips
 * extra keys downstream — the projection has to happen in the service.
 */
export function stripClearedFields(row: BookRow): BookRowPublic {
  const { userClearedFields: _userClearedFields, ...rest } = row;
  return rest;
}
