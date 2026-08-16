/**
 * Pure and MSW-free by design, like `interval-gate.test.ts` — which is why this suite can run on
 * fake timers where the transport-level suites cannot (full fake timers stall MSW). Every deadline
 * assertion advances the clock to an exact boundary instead of inferring which timer fired from
 * elapsed wall time, and timer cleanup is observed through `vi.getTimerCount()` rather than a spy on
 * `clearTimeout`. The consumer suites (`fetch.test.ts`, the indexer adapters) prove only the wiring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoundedSemaphore, type SlotRelease } from './bounded-semaphore.js';

const WAIT_MS = 10_000;

interface Watched {
  settled: boolean;
  release: SlotRelease | undefined;
  reason: unknown;
}

/** Attaches settlement handlers immediately, so a rejection is never unhandled. */
function watch(promise: Promise<SlotRelease>): Watched {
  const state: Watched = { settled: false, release: undefined, reason: undefined };
  void promise.then(
    (release) => {
      state.settled = true;
      state.release = release;
    },
    (reason: unknown) => {
      state.settled = true;
      state.reason = reason;
    },
  );
  return state;
}

/** Drains pending promise continuations without moving the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('BoundedSemaphore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('admission bound', () => {
    it('admits exactly max concurrently and queues the next acquirer', async () => {
      const semaphore = new BoundedSemaphore(2);

      const first = await semaphore.acquire();
      const second = await semaphore.acquire();
      const third = watch(semaphore.acquire());
      await flush();

      expect(third.settled).toBe(false);

      first();
      await flush();
      expect(third.release).toBeTypeOf('function');

      second();
      third.release!();
    });

    it('hands slots to waiters in acquisition order', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const admitted: string[] = [];

      const queued = ['first', 'second', 'third'].map((label) =>
        semaphore.acquire().then((release) => {
          admitted.push(label);
          return release;
        }),
      );
      await flush();
      expect(admitted).toEqual([]);

      let release = held;
      for (const pending of queued) {
        release();
        await flush();
        release = await pending;
      }

      expect(admitted).toEqual(['first', 'second', 'third']);
      release();
    });
  });

  describe('release', () => {
    it('treats a double release as a no-op so capacity cannot inflate past max', async () => {
      const semaphore = new BoundedSemaphore(2);
      const first = await semaphore.acquire();
      const second = await semaphore.acquire();

      first();
      first();
      await flush();

      const replacement = await semaphore.acquire();
      const overflow = watch(semaphore.acquire());
      await flush();

      expect(overflow.settled).toBe(false);

      second();
      replacement();
      await flush();
      overflow.release!();
    });

    it('frees the slot even when the caller released before any waiter existed', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      held();

      const next = await semaphore.acquire();
      expect(next).toBeTypeOf('function');
      next();
    });
  });

  describe('bounded wait', () => {
    it('holds the waiter to the last millisecond before waitTimeoutMs, then rejects with the supplied reason', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const expiry = new Error('slot wait expired');
      const waiter = watch(semaphore.acquire({ waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => expiry }));

      await advance(WAIT_MS - 1);
      expect(waiter.settled).toBe(false);

      await advance(1);
      expect(waiter.reason).toBe(expiry);

      held();
    });

    it('supplies its own reason when the caller gives none', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const waiter = watch(semaphore.acquire({ waitTimeoutMs: WAIT_MS }));

      await advance(WAIT_MS);

      expect(waiter.reason).toBeInstanceOf(Error);
      expect((waiter.reason as Error).message).toBe('Timed out waiting for a slot');
      held();
    });

    it('arms no deadline at all when waitTimeoutMs is omitted', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const waiter = watch(semaphore.acquire());
      await flush();

      expect(vi.getTimerCount()).toBe(0);

      await advance(10 * WAIT_MS);
      expect(waiter.settled).toBe(false);

      held();
      await flush();
      waiter.release!();
    });

    it('removes a timed-out waiter from the queue so the next release goes to its successor', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const expired = watch(semaphore.acquire({ waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => new Error('expired') }));
      const successor = watch(semaphore.acquire());

      await advance(WAIT_MS);
      expect(expired.reason).toBeInstanceOf(Error);
      expect(successor.settled).toBe(false);

      held();
      await flush();

      expect(successor.release).toBeTypeOf('function');
      successor.release!();
    });

    it('clears the wait timer on successful acquisition, so no rejection lands after the fact', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const stray = new Error('must not fire');
      const admitted = watch(semaphore.acquire({ waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => stray }));

      await flush();
      expect(vi.getTimerCount()).toBe(1);

      held();
      await flush();
      expect(admitted.release).toBeTypeOf('function');
      expect(vi.getTimerCount()).toBe(0);

      await advance(10 * WAIT_MS);
      expect(admitted.reason).toBeUndefined();
      admitted.release!();
    });

    it('keeps the wait-timeout rejection when the caller signal aborts afterwards', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();
      const expiry = new Error('slot wait expired');
      const waiter = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => expiry }),
      );

      await advance(WAIT_MS);
      expect(waiter.reason).toBe(expiry);

      controller.abort(new Error('too late'));
      await flush();
      expect(waiter.reason).toBe(expiry);

      held();
    });
  });

  describe('cancellation', () => {
    it('rejects a queued waiter with signal.reason verbatim and detaches its listener', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

      const cancelled = watch(semaphore.acquire({ signal: controller.signal }));
      const successor = watch(semaphore.acquire());
      await flush();

      const reason = new Error('caller cancelled');
      controller.abort(reason);
      await flush();

      expect(cancelled.reason).toBe(reason);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

      held();
      await flush();
      expect(successor.release).toBeTypeOf('function');
      successor.release!();
    });

    it('does not consume a slot for a waiter that aborted while queued', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();

      const cancelled = watch(semaphore.acquire({ signal: controller.signal }));
      const successor = watch(semaphore.acquire());
      await flush();

      controller.abort(new Error('cancelled'));
      await flush();
      expect(cancelled.settled).toBe(true);
      expect(successor.settled).toBe(false);

      held();
      await flush();

      expect(successor.release).toBeTypeOf('function');
      successor.release!();
    });

    it('cancels the queued waiter’s deadline along with it', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();
      const stray = new Error('must not fire');
      const cancelled = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => stray }),
      );
      await flush();
      expect(vi.getTimerCount()).toBe(1);

      const reason = new Error('caller cancelled');
      controller.abort(reason);
      await flush();

      expect(vi.getTimerCount()).toBe(0);
      await advance(10 * WAIT_MS);
      expect(cancelled.reason).toBe(reason);

      held();
    });

    it('rejects a pre-aborted signal without taking or queuing for a slot', async () => {
      const semaphore = new BoundedSemaphore(1);
      const controller = new AbortController();
      const reason = new Error('already cancelled');
      controller.abort(reason);

      await expect(semaphore.acquire({ signal: controller.signal })).rejects.toBe(reason);

      const release = await semaphore.acquire();
      expect(release).toBeTypeOf('function');
      release();
    });
  });

  describe('drainWaiters', () => {
    it('rejects every queued waiter with the reason, clears its timer and detaches its listener', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const stray = new Error('must not fire');

      const drained = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => stray }),
      );
      await flush();
      expect(vi.getTimerCount()).toBe(1);

      const reason = new Error('drained');
      semaphore.drainWaiters(reason);
      await flush();

      expect(drained.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

      await advance(10 * WAIT_MS);
      expect(drained.reason).toBe(reason);

      held();
    });

    it('leaves occupancy alone, so a stale releaser lands on the drained instance only', async () => {
      const semaphore = new BoundedSemaphore(1);
      const stale = await semaphore.acquire();

      semaphore.drainWaiters(new Error('drained'));

      const blocked = watch(semaphore.acquire());
      await flush();
      expect(blocked.settled).toBe(false);

      stale();
      await flush();
      expect(blocked.release).toBeTypeOf('function');
      blocked.release!();
    });
  });
});
