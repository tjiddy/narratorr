/**
 * Reads `rowsAffected` off a Drizzle libSQL update/delete result.
 *
 * Drizzle's libSQL driver does not expose `rowsAffected` in its public result
 * types, so callers previously reached through `unknown` with a cast. This
 * helper is the single source of truth for that access — when Drizzle types
 * improve upstream, only this one file needs to change.
 *
 * Throws on missing `rowsAffected`: a missing field would be a driver/version
 * regression rather than a benign condition, so surfacing it loudly is
 * preferable to silently coalescing to zero (which would allow bugs like
 * infinite CAS-claim re-loops to slip through — see learnings/review-635-f2.md).
 */
export function getRowsAffected(result: unknown): number {
  const rowsAffected = (result as { rowsAffected?: unknown } | null | undefined)?.rowsAffected;
  if (typeof rowsAffected !== 'number') {
    throw new Error(
      `getRowsAffected: rowsAffected missing or non-numeric on Drizzle result (got ${typeof rowsAffected})`,
    );
  }
  return rowsAffected;
}
