/**
 * Exhaustion cooldown for the progressive query ladder (#2104 D12).
 *
 * A book whose ladder ran to its end at zero has just spent up to
 * `MAX_SEARCH_RUNGS` queries per indexer proving nothing is out there. The
 * scheduled search interval defaults to 360 minutes — 4 cycles a day — so
 * without a cooldown that cost repeats every cycle against MAM's server-side
 * rate limit, for which there is no client-side limiter. This class and the rung
 * cap are the two agreed substitutes.
 *
 * In-memory and transient by design: a process restart re-enabling the ladder is
 * accepted, and no schema change is wanted for it.
 *
 * It is deliberately NOT a field on `RetryBudget`: `runSearchJob` calls
 * `retryBudget.resetAll()` at every cycle entry, which would make a cooldown
 * stored there inert.
 */

/** How long an exhausted ladder stays suppressed — one slow-cadence full retry a day. */
export const LADDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface CooldownEntry {
  /** The D5 dedup key of RUNG 1 at the time the ladder exhausted. */
  queryKey: string;
  at: number;
}

export class SearchLadderCooldown {
  private entries = new Map<number, CooldownEntry>();

  /**
   * Should this book run rung 1 only?
   *
   * Invalidation on a book-metadata change is AUTOMATIC and seam-free: the
   * caller passes the rung-1 key recomputed from the book's CURRENT title and
   * primary author, and a mismatch means the canonical query itself changed, so
   * the entry describes a different search and is dropped.
   *
   * That is deliberately chosen over wiring `clear(bookId)` into mutation seams.
   * `BookService.update` and `fixMatch` are separate paths — `fixMatch` does not
   * route through `update` — so seam wiring would have to enumerate both plus
   * every future mutation path, and would silently rot when one is added. Key
   * comparison covers every path that can change the query, including ones that
   * do not exist yet, and it removes the "which fields count as a metadata
   * change" question entirely: the fields that count are exactly the fields
   * rung 1 is built from.
   *
   * `now` is injected rather than read from the clock so this stays pure and
   * testable without fake timers.
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

  /** Record that this book's full ladder ran to its end with every rung a genuine zero. */
  recordExhausted(bookId: number, rung1Key: string, now: number): void {
    this.entries.set(bookId, { queryKey: rung1Key, at: now });
  }

  /** Drop a book's entry — a rung-1 hit means the canonical query works again. */
  clear(bookId: number): void {
    this.entries.delete(bookId);
  }
}
