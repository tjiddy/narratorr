/**
 * Suppress repeated full ladders after every rung returns zero. This is process-local by design;
 * `RetryBudget` cannot own it because scheduled-job entry resets that budget.
 */

/** Allow one slow-cadence full retry per day. */
export const LADDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface CooldownEntry {
  /** Rung-one key used for metadata-change invalidation. */
  queryKey: string;
  at: number;
}

export class SearchLadderCooldown {
  private entries = new Map<number, CooldownEntry>();

  /**
   * A changed rung-one key invalidates automatically, avoiding mutation-seam wiring. `now` is
   * injected to keep the decision deterministic.
   */
  shouldRestrict(bookId: number, rung1Key: string, now: number): boolean {
    const entry = this.entries.get(bookId);
    if (!entry) return false;
    if (entry.queryKey !== rung1Key || now - entry.at >= LADDER_COOLDOWN_MS) {
      this.entries.delete(bookId);
      return false;
    }
    return true;
  }

  recordExhausted(bookId: number, rung1Key: string, now: number): void {
    this.entries.set(bookId, { queryKey: rung1Key, at: now });
  }

  clear(bookId: number): void {
    this.entries.delete(bookId);
  }
}
