interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

interface KeyedQueue {
  waiters: Waiter[];
  nextAllowedAt: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

function detach(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

/**
 * A FIFO dispatch gate holding one minimum interval per key. N acquires issued in the same tick
 * resolve at `t`, `t + interval`, `t + 2 * interval`, in acquire order — the property a
 * read-the-stamp-then-sleep gate does not have, since overlapping callers there read one stamp,
 * sleep the same amount and dispatch together.
 *
 * Slots are released by the interval timer, never by a caller's work finishing: a caller that
 * hangs, throws or never settles delays nothing but itself, so no `try/finally` release
 * bookkeeping exists or is needed.
 */
export class IntervalGate {
  private readonly intervalMs: number;
  private readonly queues = new Map<string, KeyedQueue>();

  constructor(intervalMs: number) {
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  }

  /**
   * Resolves when the caller may dispatch on `key`; callers that omit it share one floor. Rejects
   * only when `signal` aborts — with that signal's own reason, whatever its shape — or when
   * `reset` drains the queue. A caller that passes neither can treat this as non-rejecting.
   */
  acquire(key = '', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const queue = this.queueFor(key);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = queue.waiters.indexOf(waiter);
          if (index >= 0) queue.waiters.splice(index, 1);
          detach(waiter);
          reject(signal.reason);
          // The floor is deliberately untouched: an abandoned waiter neither adds to nor subtracts
          // from whatever its successor still owes.
          this.pump(queue);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.waiters.push(waiter);
      this.pump(queue);
    });
  }

  /**
   * Drains every queue: cancels pending delay timers, detaches abort listeners, rejects every
   * still-queued waiter with `reason` and drops every stamp. A bare `Map.clear()` would leave
   * timer closures armed and promises permanently pending, which surfaces later as flake.
   */
  reset(reason: unknown): void {
    for (const queue of this.queues.values()) {
      if (queue.timer !== undefined) clearTimeout(queue.timer);
      queue.timer = undefined;
      for (const waiter of queue.waiters.splice(0)) {
        detach(waiter);
        waiter.reject(reason);
      }
    }
    this.queues.clear();
  }

  private queueFor(key: string): KeyedQueue {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { waiters: [], nextAllowedAt: 0 };
      this.queues.set(key, queue);
    }
    return queue;
  }

  private pump(queue: KeyedQueue): void {
    if (queue.timer !== undefined) return;
    while (queue.waiters.length > 0) {
      const wait = this.waitFor(queue);
      if (wait > 0) {
        queue.timer = setTimeout(() => {
          queue.timer = undefined;
          // Dispatch on the armed timer instead of re-reading the clock. Under the repo's
          // `toFake: ['Date']` harness the clock is frozen while timers still run, and a fire that
          // recomputes the remainder finds it unchanged and re-arms forever.
          this.dispatchHead(queue);
          this.pump(queue);
        }, wait);
        return;
      }
      this.dispatchHead(queue);
    }
  }

  private dispatchHead(queue: KeyedQueue): void {
    const waiter = queue.waiters.shift();
    if (!waiter) return;
    detach(waiter);
    queue.nextAllowedAt = Date.now() + this.intervalMs;
    waiter.resolve();
  }

  /**
   * `Date.now()` is wall clock, so a backwards step would otherwise park the queue for the size of
   * the step. Repairing the stored deadline — not just the returned wait — bounds any wait at one
   * interval even when the wait ends in no dispatch, as it does when the only waiter aborts. A
   * forward step yields zero and lets a single early request through, accepted since the
   * alternative is an unbounded stall.
   */
  private waitFor(queue: KeyedQueue): number {
    const remaining = queue.nextAllowedAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return 0;
    if (remaining > this.intervalMs) {
      queue.nextAllowedAt = Date.now() + this.intervalMs;
      return this.intervalMs;
    }
    return remaining;
  }
}
