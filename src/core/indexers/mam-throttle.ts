import { MAM_MIN_REQUEST_INTERVAL_MS } from '../utils/constants.js';
import { normalizedHostPortFromUrl } from '../utils/network-service.js';

/**
 * Canonical destination identity for the gate. The tracker rate-limits a listener, so path, query,
 * host case and an explicit default port are all aliases of one key, while a differing scheme
 * separates through its default port. Never throws: a throw at the transport boundary would turn a
 * working search into a failure, so an unparseable base URL keys on the raw string it was given.
 */
export function mamThrottleKey(baseUrl: string): string {
  try {
    return normalizedHostPortFromUrl(new URL(baseUrl));
  } catch {
    return baseUrl;
  }
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

interface DestinationQueue {
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
 * A FIFO dispatch gate holding one minimum interval per canonical MAM destination.
 *
 * Slots are released by the interval timer, never by a caller's request finishing: a request that
 * hangs for the full `INDEXER_TIMEOUT_MS`, throws, or is aborted delays nothing but itself, so no
 * `try/finally` release bookkeeping exists or is needed.
 */
export class MamRequestThrottle {
  private readonly intervalMs: number;
  private readonly queues = new Map<string, DestinationQueue>();

  constructor(intervalMs: number = MAM_MIN_REQUEST_INTERVAL_MS) {
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  }

  /**
   * Resolves when the caller may dispatch to `baseUrl`. Rejects only when `signal` aborts — with
   * that signal's own reason, whatever its shape — or when the testing reset drains the queue.
   */
  acquire(baseUrl: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const queue = this.queueFor(mamThrottleKey(baseUrl));
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

  /** Drains every queue; see `_resetMamThrottleForTesting` for the contract. */
  reset(): void {
    for (const queue of this.queues.values()) {
      if (queue.timer !== undefined) clearTimeout(queue.timer);
      queue.timer = undefined;
      for (const waiter of queue.waiters.splice(0)) {
        detach(waiter);
        waiter.reject(new Error('MAM throttle reset'));
      }
    }
    this.queues.clear();
  }

  private queueFor(key: string): DestinationQueue {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { waiters: [], nextAllowedAt: 0 };
      this.queues.set(key, queue);
    }
    return queue;
  }

  private pump(queue: DestinationQueue): void {
    if (queue.timer !== undefined) return;
    while (queue.waiters.length > 0) {
      const wait = this.waitFor(queue);
      if (wait > 0) {
        queue.timer = setTimeout(() => {
          queue.timer = undefined;
          this.pump(queue);
        }, wait);
        return;
      }
      const waiter = queue.waiters.shift()!;
      detach(waiter);
      queue.nextAllowedAt = Date.now() + this.intervalMs;
      waiter.resolve();
    }
  }

  /**
   * `Date.now()` is wall clock, so a backwards step would otherwise park the queue for the size of
   * the step; repairing the stamp bounds any wait at one interval. A forward step yields zero and
   * lets a single early request through — accepted, since the alternative is an unbounded stall.
   */
  private waitFor(queue: DestinationQueue): number {
    const remaining = queue.nextAllowedAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return 0;
    if (remaining > this.intervalMs) {
      queue.nextAllowedAt = Date.now() + this.intervalMs;
      return this.intervalMs;
    }
    return remaining;
  }
}

/** Process-local because Narratorr runs as one Node process; see AC5 on why it is not per-adapter. */
export const mamThrottle = new MamRequestThrottle();

/**
 * Clears every stamp, cancels every pending delay timer, detaches every abort listener and rejects
 * every still-queued waiter. A bare `Map.clear()` would leave timer closures armed and promises
 * permanently pending, which surfaces later as flake. Production has no reset caller.
 */
export function _resetMamThrottleForTesting(): void {
  mamThrottle.reset();
}
