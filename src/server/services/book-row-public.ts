import type { BookRow, BookRowPublic } from './types.js';

/** Remove raw cleared-field storage before unschematized service rows reach HTTP responses. */
export function stripClearedFields(row: BookRow): BookRowPublic {
  const { userClearedFields: _userClearedFields, ...rest } = row;
  return rest;
}
