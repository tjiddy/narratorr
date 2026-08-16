/** Idempotent by construction, so duplicate teardown signals cannot over-release. */
export type SlotRelease = () => void;

export interface AcquireSlotOptions {
  /** Rejects a queued waiter with this signal's own reason, whatever its shape. */
  signal?: AbortSignal | undefined;
  /** Reject rather than queue forever once this many ms elapse without admission. */
  waitTimeoutMs?: number | undefined;
  /** Built only if the deadline fires, so the caller owns the error type and its wording. */
  waitTimeoutReason?: (() => unknown) | undefined;
}

interface Waiter {
  resolve: (release: SlotRelease) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A FIFO concurrency bound whose waiters can leave the queue: a deadline, an abort or a drain
 * removes the waiter, so a later release can never hand a slot to a caller that is no longer there
 * — which would shrink the live pool permanently.
 *
 * Slots are released by the caller's own releaser, never by a timer: the resource being bounded is
 * held for as long as the caller's work runs.
 *
 * The bound is mutable. A raise admits waiters immediately; a shrink withholds admission until
 * occupancy falls back below the new bound. FIFO holds for `acquire` and `tryAcquire` alike without
 * either consulting the queue, because every transition that frees capacity ends in `pump()` — so a
 * queued waiter implies `active >= max`, and there is no spare slot for a newcomer to barge into.
 */
export class BoundedSemaphore {
  private readonly waiters: Waiter[] = [];
  private active = 0;

  constructor(private max: number) {}

  /**
   * Pumping is what keeps a raise live: a release is otherwise the only way in, so raising a bound
   * that has already drained to zero would strand its queue with no holder left to let it out.
   */
  setMax(newMax: number): void {
    this.max = newMax;
    this.pump();
  }

  /** Non-blocking counterpart to `acquire()`: takes a slot only if one is free at this instant. */
  tryAcquire(): SlotRelease | null {
    if (this.active < this.max) {
      this.active++;
      return this.makeRelease();
    }
    return null;
  }

  /**
   * Resolves with the releaser for one slot. Rejects only when `signal` aborts, when
   * `waitTimeoutMs` elapses first, or when `drainWaiters` empties the queue.
   */
  acquire(options: AcquireSlotOptions = {}): Promise<SlotRelease> {
    const { signal, waitTimeoutMs, waitTimeoutReason } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<SlotRelease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false, signal };

      if (signal) {
        waiter.onAbort = () => {
          this.abandon(waiter);
          reject(signal.reason);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      if (waitTimeoutMs !== undefined && Number.isFinite(waitTimeoutMs)) {
        waiter.timer = setTimeout(() => {
          this.abandon(waiter);
          reject(waitTimeoutReason?.() ?? new Error('Timed out waiting for a slot'));
        }, waitTimeoutMs);
      }

      this.waiters.push(waiter);
    });
  }

  /**
   * Rejects every still-queued waiter with `reason`, cancels its deadline and detaches its abort
   * listener. A bare queue truncation would leave those promises permanently pending and those
   * timers armed, which surfaces later as flake.
   *
   * Occupancy is deliberately untouched: a releaser is bound to this instance, so a caller still
   * holding a slot decrements the instance it acquired from and cannot inflate a replacement's
   * capacity. That is what keeps the live bound at `max` across a reset of a keyed registry.
   */
  drainWaiters(reason: unknown): void {
    for (const waiter of this.waiters.splice(0)) {
      this.detach(waiter);
      waiter.settled = true;
      waiter.reject(reason);
    }
  }

  /** Removes an unadmitted waiter; safe to call twice, since only the first settlement counts. */
  private abandon(waiter: Waiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.detach(waiter);
  }

  private detach(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.timer = undefined;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = undefined;
    }
  }

  private makeRelease(): SlotRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }

  // A prior setMax shrink may leave active above max; do not wake until capacity returns.
  private pump(): void {
    while (this.active < this.max) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.detach(waiter);
      waiter.settled = true;
      this.active++;
      waiter.resolve(this.makeRelease());
    }
  }
}
