/**
 * Pure and MSW-free by design: full fake timers stall MSW, so the gate's timing lives here and the
 * adapter suite proves only the wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAM_MIN_REQUEST_INTERVAL_MS } from '../utils/constants.js';
import { IndexerError } from './errors.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';
import { MamRequestThrottle, mamThrottle, mamThrottleKey, _resetMamThrottleForTesting } from './mam-throttle.js';

const INTERVAL = MAM_MIN_REQUEST_INTERVAL_MS;
const DESTINATION = 'https://mam.test';

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

describe('MamRequestThrottle', () => {
  let log: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    _resetMamThrottleForTesting();
    log = [];
  });

  afterEach(() => {
    _resetMamThrottleForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('spacing', () => {
    it('resolves the first-ever acquire on a fresh key with no wait', async () => {
      const first = watch('first', mamThrottle.acquire(DESTINATION), log);

      await flush();

      expect(first.resolved).toBe(true);
    });

    it('holds a following acquire for exactly one interval, not a tick less', async () => {
      watch('first', mamThrottle.acquire(DESTINATION), log);
      await flush();

      const second = watch('second', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL - 1);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(second.resolved).toBe(true);
    });

    // The property the timestamp-compare form in metadata.service.ts does not have: three
    // simultaneous acquires there read one stamp, sleep the same amount, and dispatch together.
    it('spaces concurrent acquires in acquire order rather than coalescing them', async () => {
      const w1 = watch('w1', mamThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION), log);
      const w3 = watch('w3', mamThrottle.acquire(DESTINATION), log);

      await flush();
      expect(log).toEqual(['w1']);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(log).toEqual(['w1', 'w2']);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(log).toEqual(['w1', 'w2', 'w3']);
      expect([w1, w2, w3].every((w) => w.resolved && !w.rejected)).toBe(true);
    });

    it('measures the floor from the previous resolve, so an idle gap costs nothing', async () => {
      watch('first', mamThrottle.acquire(DESTINATION), log);
      await flush();
      await vi.advanceTimersByTimeAsync(INTERVAL * 4);

      const second = watch('second', mamThrottle.acquire(DESTINATION), log);
      await flush();

      expect(second.resolved).toBe(true);
    });

    it('waits zero for an acquire issued exactly at the floor', async () => {
      watch('first', mamThrottle.acquire(DESTINATION), log);
      await flush();
      await vi.advanceTimersByTimeAsync(INTERVAL);

      const second = watch('second', mamThrottle.acquire(DESTINATION), log);
      await flush();

      expect(second.resolved).toBe(true);
    });
  });

  describe('completion independence', () => {
    it('releases on the interval even when the acquiring caller never settles', async () => {
      await mamThrottle.acquire(DESTINATION);
      void new Promise<never>(() => {});

      const second = watch('second', mamThrottle.acquire(DESTINATION), log);
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(second.resolved).toBe(true);
    });

    it('keeps advancing after the acquiring caller\'s own work rejects', async () => {
      await mamThrottle.acquire(DESTINATION);
      await expect(Promise.reject(new IndexerError('MyAnonamouse', 'HTTP 429'))).rejects.toThrow('HTTP 429');

      const second = watch('second', mamThrottle.acquire(DESTINATION), log);
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(second.resolved).toBe(true);
    });
  });

  describe('mamThrottleKey', () => {
    const aliases = [
      'https://www.myanonamouse.net',
      'https://www.myanonamouse.net/',
      'https://WWW.MyAnonaMouse.net',
      'https://www.myanonamouse.net:443/',
      'https://www.myanonamouse.net/tor?x=1',
    ];

    for (const alias of aliases) {
      it(`collapses ${alias} onto the canonical destination`, () => {
        expect(mamThrottleKey(alias)).toBe('www.myanonamouse.net:443');
      });
    }

    it('renders the canonical destination as lowercase host:port', () => {
      expect(mamThrottleKey('http://MAM.example/tor')).toBe('mam.example:80');
      expect(mamThrottleKey('https://mam.example:8443/tor')).toBe('mam.example:8443');
    });

    // Stated as distinctness, not as the helper's output format: a format assertion here would red
    // under any key rule at all, which is what the collapse cases above already pin.
    it('keeps an explicit non-default port distinct from the scheme default', () => {
      expect(mamThrottleKey('https://mam.example:8443')).not.toBe(mamThrottleKey('https://mam.example'));
    });

    it('separates schemes through their default ports', () => {
      expect(mamThrottleKey('http://mam.example')).not.toBe(mamThrottleKey('https://mam.example'));
    });

    it('strips IPv6 brackets, matching normalizedHostPortFromUrl', () => {
      expect(mamThrottleKey('https://[2001:db8::1]:8443/tor')).toBe('2001:db8::1:8443');
      expect(mamThrottleKey('http://[::1]:8080/')).toBe('::1:8080');
    });

    it('never throws on an unparseable base URL and keys it self-consistently', () => {
      expect(() => mamThrottleKey('not a url')).not.toThrow();
      expect(() => mamThrottleKey('')).not.toThrow();
      expect(mamThrottleKey('not a url')).toBe(mamThrottleKey('not a url'));
      expect(mamThrottleKey('')).toBe(mamThrottleKey(''));
      expect(mamThrottleKey('not a url')).not.toBe(mamThrottleKey('also not a url'));
    });
  });

  describe('key contention', () => {
    it('makes aliases of one destination contend for one floor', async () => {
      const first = watch('first', mamThrottle.acquire('https://www.myanonamouse.net'), log);
      const second = watch('second', mamThrottle.acquire('https://WWW.MyAnonaMouse.net:443/tor'), log);

      await flush();
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(second.resolved).toBe(true);
    });

    it('lets genuinely different destinations dispatch together', async () => {
      const a = watch('a', mamThrottle.acquire('https://mam.example'), log);
      const b = watch('b', mamThrottle.acquire('https://other.example'), log);

      await flush();

      expect(a.resolved).toBe(true);
      expect(b.resolved).toBe(true);
    });

    it('unparseable base URLs contend only with themselves', async () => {
      const a = watch('a', mamThrottle.acquire('not a url'), log);
      const b = watch('b', mamThrottle.acquire('not a url'), log);
      const c = watch('c', mamThrottle.acquire('also not a url'), log);

      await flush();

      expect(a.resolved).toBe(true);
      expect(b.resolved).toBe(false);
      expect(c.resolved).toBe(true);
    });

    // The adapter cache is cleared on every indexer update and on the network-settings path, so a
    // mid-cycle eviction rebuilds the adapter; the floor belongs to the destination, not the object.
    it('gives two adapter instances built from alias base URLs one floor', async () => {
      const acquireSpy = vi.spyOn(mamThrottle, 'acquire').mockRejectedValue(new Error('gated'));
      const evicted = new MyAnonamouseIndexer({ mamId: 'x', baseUrl: 'https://www.myanonamouse.net', searchLanguages: [1], searchType: 'active' });
      const rebuilt = new MyAnonamouseIndexer({ mamId: 'x', baseUrl: 'https://WWW.MyAnonaMouse.net:443/', searchLanguages: [1], searchType: 'active' });

      await expect(evicted.search('a')).rejects.toThrow('gated');
      await expect(rebuilt.search('a')).rejects.toThrow('gated');
      const firstUrl = acquireSpy.mock.calls[0]![0];
      const secondUrl = acquireSpy.mock.calls[1]![0];
      acquireSpy.mockRestore();

      const first = watch('first', mamThrottle.acquire(firstUrl), log);
      const second = watch('second', mamThrottle.acquire(secondUrl), log);
      await flush();
      expect(first.resolved).toBe(true);
      expect(second.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(second.resolved).toBe(true);
    });
  });

  describe('abort', () => {
    it('drops a waiter aborted before the floor expires without changing its successor\'s wait', async () => {
      const w1 = watch('w1', mamThrottle.acquire(DESTINATION), log);
      const controller = new AbortController();
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION, controller.signal), log);
      const w3 = watch('w3', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(w1.resolved).toBe(true);

      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await flush();

      expect(w2.rejected).toBe(true);
      expect(w2.reason).toBe(controller.signal.reason);
      // Hand-off is immediate; dispatch is not — w3 still owes the rest of the interval.
      expect(w3.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL - 10 - 1);
      expect(w3.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(w3.resolved).toBe(true);
    });

    it('leaves the floor untouched when an already-aborted acquire arrives after it expired', async () => {
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      await flush();
      await vi.advanceTimersByTimeAsync(INTERVAL + 50);

      const w2 = watch('w2', mamThrottle.acquire(DESTINATION, AbortSignal.abort(new Error('gone'))), log);
      await flush();
      expect(w2.rejected).toBe(true);

      const w3 = watch('w3', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(w3.resolved).toBe(true);
    });

    it('rejects an already-aborted acquire on a fresh key without blocking the next one', async () => {
      const reason = new Error('already gone');
      const w1 = watch('w1', mamThrottle.acquire('https://fresh.example', AbortSignal.abort(reason)), log);
      await flush();

      expect(w1.rejected).toBe(true);
      expect(w1.reason).toBe(reason);

      const w2 = watch('w2', mamThrottle.acquire('https://fresh.example'), log);
      await flush();
      expect(w2.resolved).toBe(true);
    });

    it('never rejects an acquire made without a signal', async () => {
      const waiters = [
        watch('w1', mamThrottle.acquire(DESTINATION), log),
        watch('w2', mamThrottle.acquire(DESTINATION), log),
        watch('w3', mamThrottle.acquire(DESTINATION), log),
      ];

      await vi.advanceTimersByTimeAsync(INTERVAL * 2);

      expect(waiters.every((w) => w.resolved && !w.rejected)).toBe(true);
    });

    // Control: without this, a "reject on any signal" regression is invisible.
    it('still waits and resolves for a live, un-aborted signal', async () => {
      const controller = new AbortController();
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION, controller.signal), log);

      await flush();
      expect(w2.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(w2.resolved).toBe(true);
      expect(w2.rejected).toBe(false);
    });

    it('rejects a queued waiter with the signal\'s own reason whatever its shape', async () => {
      const reason = new IndexerError('MyAnonamouse', 'deadline reached');
      const controller = new AbortController();
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION, controller.signal), log);
      await flush();

      controller.abort(reason);
      await flush();

      expect(w2.reason).toBe(reason);
    });

    it('rejects an already-aborted acquire with the signal\'s own reason whatever its shape', async () => {
      const reason = new IndexerError('MyAnonamouse', 'deadline reached before dispatch');
      const w1 = watch('w1', mamThrottle.acquire(DESTINATION, AbortSignal.abort(reason)), log);

      await flush();

      expect(w1.reason).toBe(reason);
    });
  });

  describe('boundary and degenerate values', () => {
    it('resolves every acquire immediately, in order, when the interval is zero', async () => {
      const gate = new MamRequestThrottle(0);
      const waiters = [
        watch('w1', gate.acquire(DESTINATION), log),
        watch('w2', gate.acquire(DESTINATION), log),
        watch('w3', gate.acquire(DESTINATION), log),
      ];

      await flush();

      expect(log).toEqual(['w1', 'w2', 'w3']);
      expect(waiters.every((w) => w.resolved)).toBe(true);
    });

    it('bounds the wait at one interval when the clock steps backwards', async () => {
      vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      await flush();

      vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(w2.resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(w2.resolved).toBe(true);
    });

    it('waits zero when the clock steps forwards past the floor', async () => {
      vi.setSystemTime(new Date('2026-08-14T00:00:00.000Z'));
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      await flush();

      vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION), log);
      await flush();

      expect(w2.resolved).toBe(true);
    });
  });

  describe('reset lifecycle', () => {
    it('settles every queued waiter as rejected', async () => {
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION), log);
      const w3 = watch('w3', mamThrottle.acquire(DESTINATION), log);
      await flush();

      _resetMamThrottleForTesting();
      await flush();

      expect(w2.rejected).toBe(true);
      expect(w3.rejected).toBe(true);
    });

    it('cancels the pending delay timer', async () => {
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      watch('w2', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      _resetMamThrottleForTesting();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('detaches abort listeners, so a late abort settles nothing and arms nothing', async () => {
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const w2 = watch('w2', mamThrottle.acquire(DESTINATION, controller.signal), log);
      await flush();

      _resetMamThrottleForTesting();
      await flush();
      expect(w2.rejected).toBe(true);
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      const settledReason = w2.reason;

      controller.abort(new Error('too late'));
      await flush();

      expect(w2.reason).toBe(settledReason);
      expect(vi.getTimerCount()).toBe(0);
      const w3 = watch('w3', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(w3.resolved).toBe(true);
    });

    it('drops every stamp, so the next acquire on a used key waits zero', async () => {
      watch('w1', mamThrottle.acquire(DESTINATION), log);
      await flush();

      _resetMamThrottleForTesting();

      const w2 = watch('w2', mamThrottle.acquire(DESTINATION), log);
      await flush();
      expect(w2.resolved).toBe(true);
    });

    it('is a no-op on an empty gate', () => {
      expect(() => _resetMamThrottleForTesting()).not.toThrow();
      expect(() => _resetMamThrottleForTesting()).not.toThrow();
    });
  });

  // Transient by design: no table, no settings row, nothing persisted — the module's whole runtime
  // surface is the gate, its key rule and its reset. The interval is imported, never re-exported.
  it('exports exactly the four runtime names', async () => {
    const ns = await import('./mam-throttle.js');

    expect(Object.keys(ns).sort()).toEqual(
      ['MamRequestThrottle', '_resetMamThrottleForTesting', 'mamThrottle', 'mamThrottleKey'].sort(),
    );
  });
});
