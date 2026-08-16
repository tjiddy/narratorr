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

    it('leaves occupancy alone for tryAcquire too, so a drain cannot conjure a free slot', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const drained = watch(semaphore.acquire());

      semaphore.drainWaiters(new Error('drained'));
      await flush();
      expect(drained.reason).toBeInstanceOf(Error);

      expect(semaphore.tryAcquire()).toBeNull();

      held();
      const admitted = semaphore.tryAcquire();
      expect(admitted).toBeTypeOf('function');
      admitted!();
    });
  });

  describe('tryAcquire', () => {
    it('admits while under the bound and refuses at it', () => {
      const semaphore = new BoundedSemaphore(2);

      const first = semaphore.tryAcquire();
      const second = semaphore.tryAcquire();

      expect(first).toBeTypeOf('function');
      expect(second).toBeTypeOf('function');
      expect(semaphore.tryAcquire()).toBeNull();

      first!();
      second!();
    });

    it('refuses without blocking at a zero bound', () => {
      expect(new BoundedSemaphore(0).tryAcquire()).toBeNull();
    });

    it('frees the slot for the next tryAcquire when its token is spent', () => {
      const semaphore = new BoundedSemaphore(1);
      const held = semaphore.tryAcquire();
      expect(semaphore.tryAcquire()).toBeNull();

      held!();

      const next = semaphore.tryAcquire();
      expect(next).toBeTypeOf('function');
      next!();
    });

    it('returns exactly one slot for a token spent twice, so the cap cannot inflate (#1984)', () => {
      const semaphore = new BoundedSemaphore(1);
      const held = semaphore.tryAcquire();

      held!();
      held!();

      const replacement = semaphore.tryAcquire();
      expect(replacement).toBeTypeOf('function');
      expect(semaphore.tryAcquire()).toBeNull();
      replacement!();
    });

    it("cannot free someone else's live slot by spending a stale token twice (#1984)", () => {
      const semaphore = new BoundedSemaphore(2);
      const first = semaphore.tryAcquire();
      const second = semaphore.tryAcquire();

      first!();
      first!();

      const replacement = semaphore.tryAcquire();
      expect(replacement).toBeTypeOf('function');
      // `second` is still held, so the double-spend must not have returned its slot as well.
      expect(semaphore.tryAcquire()).toBeNull();

      second!();
      replacement!();
      expect(semaphore.tryAcquire()).toBeTypeOf('function');
    });

    it('hands a waiter woken by a spent token its own single-use token (#1984)', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const waiter = watch(semaphore.acquire());

      held();
      await flush();

      waiter.release!();
      waiter.release!();

      const replacement = semaphore.tryAcquire();
      expect(replacement).toBeTypeOf('function');
      expect(semaphore.tryAcquire()).toBeNull();
      replacement!();
    });
  });

  describe('setMax', () => {
    it('raises the bound so the next tryAcquire is admitted', () => {
      const semaphore = new BoundedSemaphore(1);
      const held = semaphore.tryAcquire();
      expect(semaphore.tryAcquire()).toBeNull();

      semaphore.setMax(2);

      const admitted = semaphore.tryAcquire();
      expect(admitted).toBeTypeOf('function');
      expect(semaphore.tryAcquire()).toBeNull();

      held!();
      admitted!();
    });

    it('admits queued waiters in acquisition order, up to the new bound', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const admitted: string[] = [];

      const queued = ['first', 'second', 'third'].map((label) =>
        watch(semaphore.acquire().then((release) => {
          admitted.push(label);
          return release;
        })),
      );
      await flush();
      expect(admitted).toEqual([]);

      semaphore.setMax(3);
      await flush();

      // active is now 3 (the holder plus two admitted), so the third stays queued at the new bound.
      expect(admitted).toEqual(['first', 'second']);
      expect(queued[2]!.settled).toBe(false);

      held();
      await flush();
      expect(admitted).toEqual(['first', 'second', 'third']);
      for (const waiter of queued) waiter.release!();
    });

    it('admits nobody when the new bound equals the current one', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const waiter = watch(semaphore.acquire());
      await flush();

      semaphore.setMax(1);
      await flush();

      expect(waiter.settled).toBe(false);
      expect(semaphore.tryAcquire()).toBeNull();

      held();
      await flush();
      waiter.release!();
    });

    it('withholds admission after a shrink below occupancy until capacity returns', async () => {
      const semaphore = new BoundedSemaphore(2);
      const first = await semaphore.acquire();
      const second = await semaphore.acquire();
      const waiter = watch(semaphore.acquire());
      await flush();

      semaphore.setMax(1);
      await flush();
      expect(waiter.settled).toBe(false);

      // One release only brings active back down TO the new max, which is still not below it.
      first();
      await flush();
      expect(waiter.settled).toBe(false);
      expect(semaphore.tryAcquire()).toBeNull();

      second();
      await flush();
      expect(waiter.release).toBeTypeOf('function');
      waiter.release!();
    });

    it('keeps a zero bound live: the queue survives the drain to empty and a later raise admits it', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const waiter = watch(semaphore.acquire());
      await flush();

      semaphore.setMax(0);
      await flush();
      expect(semaphore.tryAcquire()).toBeNull();

      // The last holder leaves; with no holder left to release, a raise is the only way back in.
      held();
      await flush();
      expect(waiter.settled).toBe(false);

      semaphore.setMax(1);
      await flush();

      expect(waiter.release).toBeTypeOf('function');
      waiter.release!();
    });

    it('leaves a cancellable waiter free to reject with its own reason across a shrink', async () => {
      const semaphore = new BoundedSemaphore(2);
      const first = await semaphore.acquire();
      const second = await semaphore.acquire();
      const controller = new AbortController();
      const stray = new Error('must not fire');
      const cancelled = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => stray }),
      );
      const successor = watch(semaphore.acquire());
      await flush();
      expect(vi.getTimerCount()).toBe(1);

      semaphore.setMax(1);
      const reason = new Error('caller cancelled');
      controller.abort(reason);
      await flush();

      expect(cancelled.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);

      // It left the queue, so the successor is the one the returning capacity admits.
      first();
      second();
      await flush();
      expect(successor.release).toBeTypeOf('function');
      successor.release!();
    });

    it('clears the deadline and detaches the listener of a waiter it admits on a raise', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const stray = new Error('must not fire');
      const waiter = watch(
        semaphore.acquire({ signal: controller.signal, waitTimeoutMs: WAIT_MS, waitTimeoutReason: () => stray }),
      );
      await flush();
      expect(vi.getTimerCount()).toBe(1);

      semaphore.setMax(2);
      await flush();

      expect(waiter.release).toBeTypeOf('function');
      expect(vi.getTimerCount()).toBe(0);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

      controller.abort(new Error('too late'));
      await advance(10 * WAIT_MS);
      expect(waiter.reason).toBeUndefined();

      held();
      waiter.release!();
    });

    it('gives the slot a raise frees to the older waiter, not to a caller arriving in the same tick', async () => {
      const semaphore = new BoundedSemaphore(1);
      const held = await semaphore.acquire();
      const waiter = watch(semaphore.acquire());
      await flush();

      // No await between the raise and the newcomers: the admitted waiter's `.then` has not run yet,
      // so this is the only point at which spare capacity could be observed alongside a queued waiter.
      semaphore.setMax(2);
      const barger = semaphore.tryAcquire();
      const queuedBarger = watch(semaphore.acquire());

      expect(barger).toBeNull();
      await flush();
      expect(waiter.release).toBeTypeOf('function');
      expect(queuedBarger.settled).toBe(false);

      held();
      await flush();
      expect(queuedBarger.release).toBeTypeOf('function');
      waiter.release!();
      queuedBarger.release!();
    });
  });
});
