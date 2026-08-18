/**
 * Pure and MSW-free by design: full fake timers stall MSW, so the pacer's timing lives here and the
 * adapter suites prove only the wiring. Mirrors `mam-throttle.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ABB_MIN_REQUEST_INTERVAL_MS } from '../utils/constants.js';
import {
  AbbRequestThrottle,
  abbThrottle,
  abbThrottleKey,
  acquireAbbSolverMutex,
  _resetAbbThrottleForTesting,
} from './abb-throttle.js';

const INTERVAL = ABB_MIN_REQUEST_INTERVAL_MS;
const DESTINATION = 'https://audiobookbay.test/?s=test';

interface Watched {
  resolved: boolean;
  rejected: boolean;
  reason: unknown;
}

/** Attaches settlement handlers immediately, so a rejection under fake timers is never unhandled. */
function watch<T>(label: string, promise: Promise<T>, log: string[]): Watched {
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

describe('AbbRequestThrottle', () => {
  let log: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    _resetAbbThrottleForTesting();
    log = [];
  });

  afterEach(() => {
    _resetAbbThrottleForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('the interval itself', () => {
    /**
     * Jackett's `AudioBookBay.cs` ratcheted its `requestDelay` 2.1s -> 3.1s -> 5.1s -> 6.1s against
     * real blocks; a silent reduction here re-arms the ban this whole rework exists to avoid.
     */
    it('holds ABB at Jackett\'s ratcheted 6.1s floor', () => {
      expect(ABB_MIN_REQUEST_INTERVAL_MS).toBe(6100);
    });
  });

  describe('spacing', () => {
    it('resolves the first-ever acquire on a fresh key with no wait', async () => {
      const first = watch('first', abbThrottle.acquire(DESTINATION), log);

      await flush();

      expect(first.resolved).toBe(true);
    });

    it('holds a following acquire for exactly one interval, not a tick less', async () => {
      watch('first', abbThrottle.acquire(DESTINATION), log);
      await flush();

      const second = watch('second', abbThrottle.acquire(DESTINATION), log);
      await flush();
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL - 1);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(second.resolved).toBe(true);
    });

    // Three CONCURRENT acquires, not two sequential ones: a read-sleep-restamp throttle passes the
    // sequential case and dispatches all three together here.
    it('spaces concurrent acquires in acquire order rather than coalescing them', async () => {
      const w1 = watch('w1', abbThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', abbThrottle.acquire(DESTINATION), log);
      const w3 = watch('w3', abbThrottle.acquire(DESTINATION), log);

      await flush();
      expect(log).toEqual(['w1']);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(log).toEqual(['w1', 'w2']);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(log).toEqual(['w1', 'w2', 'w3']);
      expect([w1, w2, w3].every((w) => w.resolved && !w.rejected)).toBe(true);
    });

    // An operator running one manual search on a quiet box pays nothing; that is the whole reason
    // the floor is a gate rather than a fixed per-request sleep.
    it('measures the floor from the previous dispatch, so an idle system pays zero wait', async () => {
      watch('first', abbThrottle.acquire(DESTINATION), log);
      await flush();
      await vi.advanceTimersByTimeAsync(INTERVAL * 4);

      const second = watch('second', abbThrottle.acquire(DESTINATION), log);
      await flush();

      expect(second.resolved).toBe(true);
    });
  });

  describe('abbThrottleKey', () => {
    const aliases = [
      'https://audiobookbay.lu',
      'https://audiobookbay.lu/',
      'https://AudioBookBay.LU/?s=x',
      'https://audiobookbay.lu:443/page/2/?s=x&tt=1',
      'https://audiobookbay.lu/audio-books/some-slug/',
    ];

    for (const alias of aliases) {
      it(`collapses ${alias} onto the canonical destination`, () => {
        expect(abbThrottleKey(alias)).toBe('audiobookbay.lu:443');
      });
    }

    it('keeps genuinely different hostnames apart', () => {
      expect(abbThrottleKey('https://audiobookbay.lu/')).not.toBe(abbThrottleKey('https://audiobookbay.is/'));
    });

    it('keeps an explicit non-default port distinct from the scheme default', () => {
      expect(abbThrottleKey('https://abb.test:8443')).not.toBe(abbThrottleKey('https://abb.test'));
    });

    it('never throws on an unparseable URL and keys it self-consistently', () => {
      expect(() => abbThrottleKey('not a url')).not.toThrow();
      expect(abbThrottleKey('not a url')).toBe(abbThrottleKey('not a url'));
      expect(abbThrottleKey('not a url')).not.toBe(abbThrottleKey('also not a url'));
    });
  });

  describe('key contention', () => {
    // The search page, page two and a detail page are three different URLs on one host, and the
    // ban is per-host: they must all contend for the same floor.
    it('makes a search page, a later page and a detail page share one floor', async () => {
      const search = watch('search', abbThrottle.acquire('https://audiobookbay.test/?s=x&tt=1'), log);
      const page2 = watch('page2', abbThrottle.acquire('https://audiobookbay.test/page/2/?s=x&tt=1'), log);
      const detail = watch('detail', abbThrottle.acquire('https://audiobookbay.test/audio-books/slug/'), log);

      await flush();
      expect(log).toEqual(['search']);
      expect(search.resolved).toBe(true);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(page2.resolved).toBe(true);
      expect(detail.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(detail.resolved).toBe(true);
    });

    it('lets two genuinely different ABB mirrors dispatch together', async () => {
      const a = watch('a', abbThrottle.acquire('https://audiobookbay.lu/'), log);
      const b = watch('b', abbThrottle.acquire('https://audiobookbay.is/'), log);

      await flush();

      expect(a.resolved).toBe(true);
      expect(b.resolved).toBe(true);
    });
  });

  describe('abort', () => {
    it('rejects a queued waiter with the signal\'s own reason, whatever its shape', async () => {
      // Deliberately not an Error: an `instanceof Error` assertion would pass against a wrapped
      // rejection, which is the shape the abort contract forbids.
      const reason = { cancelled: 'by the operator' };
      const controller = new AbortController();
      watch('w1', abbThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', abbThrottle.acquire(DESTINATION, controller.signal), log);
      await flush();

      controller.abort(reason);
      await flush();

      expect(w2.rejected).toBe(true);
      expect(w2.reason).toBe(reason);
    });

    it('leaves the abandoned waiter\'s successor owing its full remaining floor', async () => {
      const controller = new AbortController();
      watch('w1', abbThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', abbThrottle.acquire(DESTINATION, controller.signal), log);
      const w3 = watch('w3', abbThrottle.acquire(DESTINATION), log);
      await flush();

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await flush();
      expect(w2.rejected).toBe(true);
      expect(w3.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL - 100 - 1);
      expect(w3.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(w3.resolved).toBe(true);
    });

    it('rejects an already-aborted acquire without queuing it', async () => {
      const reason = { gone: true };
      const w1 = watch('w1', abbThrottle.acquire('https://fresh.test/', AbortSignal.abort(reason)), log);

      await flush();

      expect(w1.rejected).toBe(true);
      expect(w1.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);

      // The refused acquire took no slot, so the next one still dispatches instantly.
      const w2 = watch('w2', abbThrottle.acquire('https://fresh.test/'), log);
      await flush();
      expect(w2.resolved).toBe(true);
    });

    // Control: without it, a "reject on any signal" regression is invisible.
    it('still waits and resolves for a live, un-aborted signal', async () => {
      const controller = new AbortController();
      watch('w1', abbThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', abbThrottle.acquire(DESTINATION, controller.signal), log);

      await flush();
      expect(w2.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(w2.resolved).toBe(true);
      expect(w2.rejected).toBe(false);
    });
  });

  describe('the solver mutex', () => {
    const SOLVER_TARGET = 'https://audiobookbay.test/?s=x';

    // Without this, three concurrent ABB requests hold all three global solver slots while waiting
    // out 0/6.1/12.2s of pacing, starving every other indexer for the whole window.
    it('admits one holder per destination and hands the next one the slot on release', async () => {
      const first = await acquireAbbSolverMutex(SOLVER_TARGET);
      const second = watch('second', acquireAbbSolverMutex(SOLVER_TARGET), log);

      await flush();
      expect(second.resolved).toBe(false);

      first();
      await flush();
      expect(second.resolved).toBe(true);
    });

    it('keeps different destinations independent', async () => {
      await acquireAbbSolverMutex('https://audiobookbay.lu/');
      const other = watch('other', acquireAbbSolverMutex('https://audiobookbay.is/'), log);

      await flush();

      expect(other.resolved).toBe(true);
    });

    it('collapses aliases of one destination onto one mutex', async () => {
      await acquireAbbSolverMutex('https://audiobookbay.lu/?s=x');
      const alias = watch('alias', acquireAbbSolverMutex('https://AudioBookBay.LU:443/page/2/'), log);

      await flush();

      expect(alias.resolved).toBe(false);
    });

    it('rejects a queued waiter with the signal\'s own reason and frees the queue for the next', async () => {
      const reason = { cancelled: 'mutex' };
      const controller = new AbortController();
      const held = await acquireAbbSolverMutex(SOLVER_TARGET);
      const queued = watch('queued', acquireAbbSolverMutex(SOLVER_TARGET, controller.signal), log);
      await flush();

      controller.abort(reason);
      await flush();
      expect(queued.rejected).toBe(true);
      expect(queued.reason).toBe(reason);

      // The abandoned waiter must not have consumed the slot the holder is about to release.
      const successor = watch('successor', acquireAbbSolverMutex(SOLVER_TARGET), log);
      held();
      await flush();
      expect(successor.resolved).toBe(true);
    });

    it('rejects an already-aborted acquire without taking the free slot', async () => {
      const reason = { gone: true };
      const refused = watch('refused', acquireAbbSolverMutex(SOLVER_TARGET, AbortSignal.abort(reason)), log);
      await flush();
      expect(refused.reason).toBe(reason);

      const next = watch('next', acquireAbbSolverMutex(SOLVER_TARGET), log);
      await flush();
      expect(next.resolved).toBe(true);
    });

    it('is idempotent on release, so a doubled teardown cannot over-admit', async () => {
      const release = await acquireAbbSolverMutex(SOLVER_TARGET);
      release();
      release();

      const a = watch('a', acquireAbbSolverMutex(SOLVER_TARGET), log);
      const b = watch('b', acquireAbbSolverMutex(SOLVER_TARGET), log);
      await flush();

      expect(a.resolved).toBe(true);
      expect(b.resolved).toBe(false);
    });
  });

  describe('reset lifecycle', () => {
    it('settles every queued gate waiter as rejected with a plain Error naming the reset', async () => {
      watch('w1', abbThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', abbThrottle.acquire(DESTINATION), log);
      await flush();

      _resetAbbThrottleForTesting();
      await flush();

      expect(w2.rejected).toBe(true);
      expect(w2.reason).toBeInstanceOf(Error);
      expect((w2.reason as Error).message).toBe('ABB throttle reset');
    });

    it('cancels the pending delay timer', async () => {
      watch('w1', abbThrottle.acquire(DESTINATION), log);
      watch('w2', abbThrottle.acquire(DESTINATION), log);
      await flush();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      _resetAbbThrottleForTesting();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('drops every stamp, so the next acquire on a used key waits zero', async () => {
      watch('w1', abbThrottle.acquire(DESTINATION), log);
      await flush();

      _resetAbbThrottleForTesting();

      const w2 = watch('w2', abbThrottle.acquire(DESTINATION), log);
      await flush();
      expect(w2.resolved).toBe(true);
    });

    it('rejects queued mutex waiters too, rather than leaving them permanently pending', async () => {
      await acquireAbbSolverMutex(DESTINATION);
      const queued = watch('queued', acquireAbbSolverMutex(DESTINATION), log);
      await flush();
      expect(queued.resolved).toBe(false);

      _resetAbbThrottleForTesting();
      await flush();

      expect(queued.rejected).toBe(true);
      expect((queued.reason as Error).message).toBe('ABB throttle reset');
    });

    it('is a no-op on an empty throttle', () => {
      expect(() => _resetAbbThrottleForTesting()).not.toThrow();
      expect(() => _resetAbbThrottleForTesting()).not.toThrow();
    });
  });

  describe('custom-interval instances', () => {
    it('resolves every acquire immediately, in order, when the interval is zero', async () => {
      const gate = new AbbRequestThrottle(0);
      const waiters = [
        watch('w1', gate.acquire(DESTINATION), log),
        watch('w2', gate.acquire(DESTINATION), log),
        watch('w3', gate.acquire(DESTINATION), log),
      ];

      await flush();

      expect(log).toEqual(['w1', 'w2', 'w3']);
      expect(waiters.every((w) => w.resolved)).toBe(true);
    });

    it('rejects a queued waiter of a reset instance with that instance\'s reason', async () => {
      const gate = new AbbRequestThrottle(1_000);
      watch('w1', gate.acquire(DESTINATION), log);
      const w2 = watch('w2', gate.acquire(DESTINATION), log);
      await flush();

      gate.reset();
      await flush();

      expect(w2.rejected).toBe(true);
      expect((w2.reason as Error).message).toBe('ABB throttle reset');
    });
  });
});

/**
 * The gate arms one `setTimeout` and must DISPATCH when it fires rather than re-read the clock: a
 * suite that freezes `Date` while leaving timers live — the only workable shape once MSW is in play
 * — would otherwise re-arm forever and hang at the test timeout instead of failing.
 */
describe('AbbRequestThrottle under a frozen clock with live timers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains a queue of three rather than re-arming forever', async () => {
    const gate = new AbbRequestThrottle(5);

    await gate.acquire(DESTINATION);
    await expect(Promise.all([
      gate.acquire(DESTINATION),
      gate.acquire(DESTINATION),
    ])).resolves.toHaveLength(2);
  });
});

describe('abb-throttle module surface', () => {
  // Transient by design: no table, no settings row, nothing persisted. The interval is imported
  // from constants, never re-exported.
  it('exports exactly the five runtime names', async () => {
    const ns = await import('./abb-throttle.js');

    expect(Object.keys(ns).sort()).toEqual(
      ['AbbRequestThrottle', '_resetAbbThrottleForTesting', 'abbThrottle', 'abbThrottleKey', 'acquireAbbSolverMutex'].sort(),
    );
  });
});
