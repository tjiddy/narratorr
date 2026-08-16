/**
 * Pure and MSW-free by design, like `interval-gate.test.ts`: the primitive's admission, deadline and
 * cancellation mechanics live here, and the consumer suites (`fetch.test.ts`, the indexer adapters)
 * prove only the wiring. Real timers throughout — every deadline here is a handful of milliseconds,
 * and fake timers buy nothing without MSW in the picture.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BoundedSemaphore, type SlotRelease } from './bounded-semaphore.js';

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

function after(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One macrotask — enough for any already-resolvable acquisition to settle. */
function tick(): Promise<void> {
  return after(0);
}

describe('BoundedSemaphore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('admission bound', () => {
    it('admits exactly max concurrently and queues the next acquirer', async () => {
      const semaphore = new BoundedSemaphore(2);

      const first = await semaphore.acquire();
      const second = await semaphore.acquire();
      const third = watch(semaphore.acquire());
      await tick();

      expect(third.settled).toBe(false);

      first();
      await tick();
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
      await tick();
      expect(admitted).toEqual([]);

      let release = held;
      for (const pending of queued) {
        release();
        await tick();
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
      await tick();

      const replacement = await semaphore.acquire();
      const overflow = watch(semaphore.acquire());
      await tick();

      expect(overflow.settled).toBe(false);

      second();
      replacement();
      await tick();
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
    it('rejects a waiter that is not admitted within waitTimeoutMs, with the supplied reason', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const expiry = new Error('slot wait expired');

      await expect(
        semaphore.acquire({ waitTimeoutMs: 10, waitTimeoutReason: () => expiry }),
      ).rejects.toBe(expiry);

      held();
    });

    it('arms the wait deadline with exactly waitTimeoutMs', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const armed: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
        armed.push(delay ?? 0);
        return realSetTimeout(handler as () => void, 0, ...rest);
      }) as typeof globalThis.setTimeout);

      const waiter = watch(semaphore.acquire({ waitTimeoutMs: 60_000, waitTimeoutReason: () => new Error('expired') }));
      await new Promise((resolve) => realSetTimeout(resolve, 0));

      expect(armed).toEqual([60_000]);
      expect(waiter.reason).toBeInstanceOf(Error);

      held();
    });

    it('does not arm a deadline when waitTimeoutMs is omitted', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const armed: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
        armed.push(delay ?? 0);
        return realSetTimeout(handler as () => void, delay, ...rest);
      }) as typeof globalThis.setTimeout);

      const waiter = watch(semaphore.acquire());
      await new Promise((resolve) => realSetTimeout(resolve, 5));

      expect(armed).toEqual([]);
      expect(waiter.settled).toBe(false);

      held();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      waiter.release!();
    });

    it('removes a timed-out waiter from the queue so the next release goes to its successor', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const expired = watch(semaphore.acquire({ waitTimeoutMs: 10, waitTimeoutReason: () => new Error('expired') }));
      const successor = watch(semaphore.acquire());

      await after(30);
      expect(expired.reason).toBeInstanceOf(Error);
      expect(successor.settled).toBe(false);

      held();
      await tick();

      expect(successor.release).toBeTypeOf('function');
      successor.release!();
    });

    it('clears the wait timer on successful acquisition, so no rejection lands after the fact', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const stray = new Error('must not fire');
      const admitted = watch(semaphore.acquire({ waitTimeoutMs: 30, waitTimeoutReason: () => stray }));

      await tick();
      held();
      await tick();
      expect(admitted.release).toBeTypeOf('function');

      await after(50);
      expect(admitted.reason).toBeUndefined();
      admitted.release!();
    });

    it('keeps the wait-timeout rejection when the caller signal aborts afterwards', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();
      const expiry = new Error('slot wait expired');
      const waiter = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: 10, waitTimeoutReason: () => expiry }),
      );

      await after(30);
      expect(waiter.reason).toBe(expiry);

      controller.abort(new Error('too late'));
      await tick();
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
      await tick();

      const reason = new Error('caller cancelled');
      controller.abort(reason);
      await tick();

      expect(cancelled.reason).toBe(reason);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

      held();
      await tick();
      expect(successor.release).toBeTypeOf('function');
      successor.release!();
    });

    it('does not consume a slot for a waiter that aborted while queued', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();

      const cancelled = watch(semaphore.acquire({ signal: controller.signal }));
      const successor = watch(semaphore.acquire());
      await tick();

      controller.abort(new Error('cancelled'));
      await tick();
      expect(cancelled.settled).toBe(true);
      expect(successor.settled).toBe(false);

      held();
      await tick();

      expect(successor.release).toBeTypeOf('function');
      successor.release!();
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
      const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
      const stray = new Error('must not fire');

      const drained = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: 10, waitTimeoutReason: () => stray }),
      );
      await tick();

      const reason = new Error('drained');
      semaphore.drainWaiters(reason);
      await tick();

      expect(drained.reason).toBe(reason);
      expect(clearTimer).toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

      await after(30);
      expect(drained.reason).toBe(reason);

      held();
    });

    it('leaves occupancy alone, so a stale releaser lands on the drained instance only', async () => {
      const semaphore = new BoundedSemaphore(1);
      const stale = await semaphore.acquire();

      semaphore.drainWaiters(new Error('drained'));

      const blocked = watch(semaphore.acquire());
      await tick();
      expect(blocked.settled).toBe(false);

      stale();
      await tick();
      expect(blocked.release).toBeTypeOf('function');
      blocked.release!();
    });
  });
});
