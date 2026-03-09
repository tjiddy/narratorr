/**
 * A counting semaphore with FIFO wait queue for limiting concurrency.
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private max: number) {}

  /** Update the maximum concurrency limit. */
  setMax(newMax: number): void {
    this.max = newMax;
  }

  /** Block until a slot is available, then acquire it. */
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  /**
   * Non-blocking acquire attempt.
   * Returns true if a slot was acquired, false if all slots are in use.
   */
  tryAcquire(): boolean {
    if (this.active < this.max) {
      this.active++;
      return true;
    }
    return false;
  }

  /** Release a slot, unblocking the next waiter in FIFO order. */
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}
