/** Process-local retry counts, reset on restart or search-job entry. */
export class RetryBudget {
  private attempts = new Map<number, number>();

  consumeAttempt(bookId: number): number {
    const current = this.attempts.get(bookId) ?? 0;
    const next = current + 1;
    this.attempts.set(bookId, next);
    return next;
  }

  reset(bookId: number): void {
    this.attempts.delete(bookId);
  }

  resetAll(): void {
    this.attempts.clear();
  }

  hasRemaining(bookId: number, max = 3): boolean {
    const current = this.attempts.get(bookId) ?? 0;
    return current < max;
  }
}
