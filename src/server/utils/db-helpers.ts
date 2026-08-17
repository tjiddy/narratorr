import type { SQLiteSelect } from 'drizzle-orm/sqlite-core';

/**
 * Apply optional limit/offset to a select builder.
 *
 * Callers must end their chain with `.$dynamic()`: only in dynamic mode do `.limit()`/`.offset()`
 * return the type they were called on, so the conditional application needs no cast. `!== undefined`
 * rather than truthiness — `limit: 0` is a real, distinct window.
 */
export function applyPagination<T extends SQLiteSelect>(
  query: T,
  pagination?: { limit?: number; offset?: number },
): T {
  let paginated = query;
  if (pagination?.limit !== undefined) paginated = paginated.limit(pagination.limit);
  if (pagination?.offset !== undefined) paginated = paginated.offset(pagination.offset);
  return paginated;
}

// Missing rowsAffected is a driver/version contract violation, not a zero-row result.
export function getRowsAffected(result: unknown): number {
  const rowsAffected = (result as { rowsAffected?: unknown } | null | undefined)?.rowsAffected;
  if (typeof rowsAffected !== 'number') {
    throw new Error(
      `getRowsAffected: rowsAffected missing or non-numeric on Drizzle result (got ${typeof rowsAffected})`,
    );
  }
  return rowsAffected;
}
