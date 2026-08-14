/**
 * Pure and MSW-free by design: full fake timers stall MSW, so the gate's timing lives here and the
 * consumer suites (MAM's adapter, MetadataService) prove only the wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntervalGate } from './interval-gate.js';

const INTERVAL = 100;

interface Watched {
  resolved: boolean;
  rejected: boolean;
  reason: unknown;
}

/** Attaches settlement handlers immediately, so a rejection under fake timers is never unhandled. */
function watch(label: string, promise: Promise<void>, log: string[]): Watched {
  const state: Watched = { resolved: false, rejected: false, reason: undefined };
  void promise.then(
    () => {
      state.resolved = true;
      log.push(label);
    },
    (reason: unknown) => {
      state.rejected = true;
      state.reason = reason;
    },
  );
  return state;
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('IntervalGate', () => {
  let log: string[];
  let gate: IntervalGate;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    log = [];
    gate = new IntervalGate(INTERVAL);
  });

  afterEach(() => {
    gate.reset(new Error('suite teardown'));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('spacing', () => {
    it('resolves the first-ever acquire on a fresh gate with no wait', async () => {
      const first = watch('first', gate.acquire(), log);

      await flush();

      expect(first.resolved).toBe(true);
    });

    it('holds a following acquire for exactly one interval, not a tick less', async () => {
      watch('first', gate.acquire(), log);
      await flush();

      const second = watch('second', gate.acquire(), log);
      await flush();
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL - 1);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(second.resolved).toBe(true);
    });

    // The property the read-sleep-restamp form in metadata.service.ts did not have: three
    // simultaneous acquires there read one stamp, slept the same amount, and dispatched together.
    // A two-sequential-acquires test is green against that form, so this is the observation point.
    it('spaces concurrent acquires in acquire order rather than coalescing them', async () => {
      const w1 = watch('w1', gate.acquire(), log);
      const w2 = watch('w2', gate.acquire(), log);
      const w3 = watch('w3', gate.acquire(), log);

      await flush();
      expect(log).toEqual(['w1']);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(log).toEqual(['w1', 'w2']);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(log).toEqual(['w1', 'w2', 'w3']);
      expect([w1, w2, w3].every((w) => w.resolved && !w.rejected)).toBe(true);
    });

    it('measures the floor from the previous resolve, so an idle gap costs nothing', async () => {
      watch('first', gate.acquire(), log);
      await flush();
      await vi.advanceTimersByTimeAsync(INTERVAL * 4);

      const second = watch('second', gate.acquire(), log);
      await flush();

      expect(second.resolved).toBe(true);
    });

    it('waits zero for an acquire issued exactly at the floor', async () => {
      watch('first', gate.acquire(), log);
      await flush();
      await vi.advanceTimersByTimeAsync(INTERVAL);

      const second = watch('second', gate.acquire(), log);
      await flush();

      expect(second.resolved).toBe(true);
    });
  });

  describe('completion independence', () => {
    it('releases on the interval even when the acquiring caller never settles', async () => {
      await gate.acquire();
      void new Promise<never>(() => {});

      const second = watch('second', gate.acquire(), log);
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(second.resolved).toBe(true);
    });

    it('keeps advancing after the acquiring caller\'s own work rejects', async () => {
      await gate.acquire();
      await expect(Promise.reject(new Error('provider blew up'))).rejects.toThrow('provider blew up');

      const second = watch('second', gate.acquire(), log);
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(second.resolved).toBe(true);
    });
  });

  describe('keying', () => {
    it('makes repeat acquires on one key contend for one floor', async () => {
      const first = watch('first', gate.acquire('a'), log);
      const second = watch('second', gate.acquire('a'), log);

      await flush();
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(second.resolved).toBe(true);
    });

    it('lets distinct keys dispatch together', async () => {
      const a = watch('a', gate.acquire('a'), log);
      const b = watch('b', gate.acquire('b'), log);

      await flush();

      expect(a.resolved).toBe(true);
      expect(b.resolved).toBe(true);
    });

    // MetadataService holds one floor across Audible and Audnexus by passing no key at all.
    it('gives every keyless acquire the same floor', async () => {
      const first = watch('first', gate.acquire(), log);
      const second = watch('second', gate.acquire(), log);

      await flush();
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(second.resolved).toBe(true);
    });
  });

  describe('clock steps', () => {
    it('bounds the wait at one interval when the clock steps backwards', async () => {
      vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
      watch('w1', gate.acquire(), log);
      await flush();

      vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
      const w2 = watch('w2', gate.acquire(), log);
      await flush();
      expect(w2.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(w2.resolved).toBe(true);

      const w3 = watch('w3', gate.acquire(), log);
      await flush();
      expect(w3.resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(w3.resolved).toBe(true);
    });

    // Discriminates a repaired stamp from a merely clamped return value. A dispatch always
    // restamps, so the stale stamp is only observable across a wait that ends in no dispatch —
    // here because the only waiter walked away first.
    it('repairs the stored deadline, not just the returned wait', async () => {
      vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
      watch('w1', gate.acquire(), log);
      await flush();

      vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
      const controller = new AbortController();
      const abandoned = watch('abandoned', gate.acquire('', controller.signal), log);
      await flush();
      controller.abort();
      await flush();
      expect(abandoned.rejected).toBe(true);

      await vi.advanceTimersByTimeAsync(INTERVAL);

      const w2 = watch('w2', gate.acquire(), log);
      await flush();
      expect(w2.resolved).toBe(true);
    });

    it('waits zero when the clock steps forwards past the floor', async () => {
      vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
      watch('w1', gate.acquire(), log);
      await flush();

      vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
      const w2 = watch('w2', gate.acquire(), log);
      await flush();

      expect(w2.resolved).toBe(true);
    });
  });

  describe('degenerate intervals', () => {
    it('resolves every acquire immediately, in order, when the interval is zero', async () => {
      const zero = new IntervalGate(0);
      const waiters = [
        watch('w1', zero.acquire(), log),
        watch('w2', zero.acquire(), log),
        watch('w3', zero.acquire(), log),
      ];

      await flush();

      expect(log).toEqual(['w1', 'w2', 'w3']);
      expect(waiters.every((w) => w.resolved)).toBe(true);
    });

    // Same fail-open trap as the NaN backoff window: the guard belongs on the value, not the caller.
    for (const interval of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      it(`treats an interval of ${String(interval)} as no wait, still in acquire order`, async () => {
        const degenerate = new IntervalGate(interval);
        const waiters = [
          watch('w1', degenerate.acquire(), log),
          watch('w2', degenerate.acquire(), log),
          watch('w3', degenerate.acquire(), log),
        ];

        await flush();

        expect(log).toEqual(['w1', 'w2', 'w3']);
        expect(waiters.every((w) => w.resolved && !w.rejected)).toBe(true);
      });
    }
  });

  describe('reset', () => {
    it('rejects every queued waiter with the caller\'s own reason and cancels the timer', async () => {
      const reason = new Error('gate reset');
      watch('w1', gate.acquire(), log);
      const w2 = watch('w2', gate.acquire(), log);
      await flush();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      gate.reset(reason);
      await flush();

      expect(w2.rejected).toBe(true);
      expect(w2.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('drops every stamp, so the next acquire on a used key waits zero', async () => {
      watch('w1', gate.acquire(), log);
      await flush();

      gate.reset(new Error('gate reset'));

      const w2 = watch('w2', gate.acquire(), log);
      await flush();
      expect(w2.resolved).toBe(true);
    });
  });

  it('exports exactly the one runtime name', async () => {
    const ns = await import('./interval-gate.js');

    expect(Object.keys(ns).sort()).toEqual(['IntervalGate'].sort());
  });
});

/**
 * The repo's documented deadline-assertion harness fakes `Date` only, because full fake timers
 * stall MSW. A `pump()` that recomputes the remainder from the frozen clock on every fire re-arms
 * forever under it, so this liveness case runs on real timers with a tiny interval.
 */
describe('IntervalGate under a frozen clock with live timers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still dispatches two acquires issued at the same frozen instant', async () => {
    const gate = new IntervalGate(5);
    const log: string[] = [];

    const first = gate.acquire().then(() => log.push('first'));
    const second = gate.acquire().then(() => log.push('second'));

    await Promise.all([first, second]);

    expect(log).toEqual(['first', 'second']);
    expect(Date.now()).toBe(new Date('2026-08-14T00:00:00.000Z').getTime());
  });
});
