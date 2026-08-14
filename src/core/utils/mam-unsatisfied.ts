/**
 * MAM's unsatisfied-torrent allowance, read from `jsonLoad.php?snatch_summary`.
 *
 * Every validity rule lives in the reader so callers only ever hold a well-formed pair, and the
 * automatic grab filter and the UI answer "at the limit?" through the same predicate. Fail open is
 * the default in both directions: a shape MAM did not report as a usable pair reads as absent, and
 * an absent pair never blocks — a MAM response change must not silently stop all grabbing.
 */

export interface UnsatisfiedStatus {
  count: number;
  limit: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function readUnsatisfiedStatus(raw: unknown): UnsatisfiedStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { count, limit } = raw as { count?: unknown; limit?: unknown };
  if (!isNonNegativeInteger(count)) return null;
  // A zero limit is not a limit: `count >= limit` on 0/0 would block every grab on the account.
  if (!isNonNegativeInteger(limit) || limit <= 0) return null;
  return { count, limit };
}

/** MAM's own reported limit is the threshold; no hardcoded cap and no safety margin. */
export function isAtUnsatisfiedLimit(status: UnsatisfiedStatus | null | undefined): boolean {
  return status != null && status.count >= status.limit;
}

/** Only the MAM adapter annotates results, so an unannotated result can never be blocked. */
export function isResultAtUnsatisfiedLimit(result: { unsatisfied?: UnsatisfiedStatus | undefined }): boolean {
  return isAtUnsatisfiedLimit(result.unsatisfied);
}
