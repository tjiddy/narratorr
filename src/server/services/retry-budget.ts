/**
 * Transient (in-memory) retry budget tracker.
 * Tracks retry attempts per bookId in the current process.
 * Resets on server restart and when runSearchJob is invoked.
 */
export class RetryBudget {
  private attempts = new Map<number, number>();

  /** Increment and return the current attempt count for a book. */
  consumeAttempt(bookId: number): number {
    const current = this.attempts.get(bookId) ?? 0;
    const next = current + 1;
    this.attempts.set(bookId, next);
    return next;
  }

  /** Clear retry counter for a single book (used by manual retry). */
  reset(bookId: number): void {
    this.attempts.delete(bookId);
  }

  /** Clear all retry counters (called at runSearchJob entry). */
  resetAll(): void {
    this.attempts.clear();
  }

  /** Check if retry budget remains for a book. Default max is 3. */
  hasRemaining(bookId: number, max = 3): boolean {
    const current = this.attempts.get(bookId) ?? 0;
    return current < max;
  }
}
