/**
 * A counting semaphore with FIFO wait queue for limiting concurrency.
 *
 * Acquisition hands back a single-use release function instead of exposing a public
 * `release()` (#1984). The old shape delegated double-release safety to every caller:
 * `release()` decremented `active` with no floor, so releasing twice drove it negative and
 * permanently raised the process's effective concurrency cap — silently, with nothing in the
 * logs. The hazard is real specifically for teardown-driven releases, where more than one
 * signal can reach the releaser (a stream `error` plus a response `close`), and both stream
 * callers had grown identical hand-rolled `released` flags — the shape that says the
 * invariant belongs in the primitive. A second call on a release token is a no-op by
 * construction (the same disposer contract as `AbortController.abort()`), so "exactly one
 * slot back" is now unforgeable rather than a per-caller discipline.
 */

/** Single-use slot releaser. Calling it more than once is a safe no-op. */
export type SemaphoreRelease = () => void;

export class Semaphore {
  private queue: Array<(release: SemaphoreRelease) => void> = [];
  private active = 0;

  constructor(private max: number) {}

  /** Update the maximum concurrency limit. */
  setMax(newMax: number): void {
    this.max = newMax;
  }

  /** Block until a slot is available, then acquire it. Resolves with the slot's releaser. */
  async acquire(): Promise<SemaphoreRelease> {
    if (this.active < this.max) {
      this.active++;
      return this.makeRelease();
    }
    return new Promise<SemaphoreRelease>(resolve => {
      this.queue.push(resolve);
    });
  }

  /**
   * Non-blocking acquire attempt.
   * Returns the slot's releaser, or null if all slots are in use.
   */
  tryAcquire(): SemaphoreRelease | null {
    if (this.active < this.max) {
      this.active++;
      return this.makeRelease();
    }
    return null;
  }

  /** Mint the single-use releaser for a slot that was just counted into `active`. */
  private makeRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  /**
   * Return a slot, unblocking the next waiter in FIFO order.
   * Only wakes a waiter when capacity allows — guards against a prior
   * setMax() shrink that left active above the new max (waking then would
   * push active past max). Latent today (no blocking acquire() caller races
   * a shrink), but keeps the invariant active <= max for any future
   * setMax()+acquire() combo.
   */
  private releaseSlot(): void {
    this.active--;
    if (this.active < this.max) {
      const next = this.queue.shift();
      if (next) {
        this.active++;
        next(this.makeRelease());
      }
    }
  }
}
