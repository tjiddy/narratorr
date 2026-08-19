import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { withSearchDeadline, SearchDeadlineError, _resetSearchRegistryForTesting } from './search-deadline.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: vi.fn(), silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

/** Capture the deadline's own `setTimeout` and expose its delay, handle, and callback. */
function captureTimer() {
  const armed: Array<{ delay: number; handle: { unref: ReturnType<typeof vi.fn> }; fire: () => void }> = [];
  const original = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number) => {
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout> & { unref: ReturnType<typeof vi.fn> };
    armed.push({ delay: delay ?? 0, handle: handle as unknown as { unref: ReturnType<typeof vi.fn> }, fire: fn });
    return handle;
  }) as unknown as typeof setTimeout);
  return { armed, spy, original };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let queued microtasks drain without advancing any timer. */
const flush = () => new Promise((r) => setImmediate(r));

describe('withSearchDeadline', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    _resetSearchRegistryForTesting();
    log = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSearchRegistryForTesting();
  });

  describe('the timer', () => {
    it('arms exactly one timer with the caller budget and unrefs it', async () => {
      const { armed, spy } = captureTimer();
      const work = deferred<string>();

      const raced = withSearchDeadline({ budgetMs: 1_500_000, bookId: 7, log }, () => work.promise);
      expect(armed).toHaveLength(1);
      expect(armed[0]!.delay).toBe(1_500_000);
      expect(armed[0]!.handle.unref).toHaveBeenCalledTimes(1);

      work.resolve('done');
      await expect(raced).resolves.toBe('done');
      spy.mockRestore();
    });

    it('clears the timer when the work settles first and never aborts the signal', async () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      let seen: AbortSignal | undefined;

      await expect(withSearchDeadline({ budgetMs: 1_000, bookId: 1, log }, (signal) => {
        seen = signal;
        return Promise.resolve('ok');
      })).resolves.toBe('ok');

      expect(seen!.aborted).toBe(false);
      expect(clearSpy).toHaveBeenCalled();
    });

    it.each([0, -1])('does not arm a timer when budgetMs is %i', async (budgetMs) => {
      const { armed } = captureTimer();
      let seen: AbortSignal | undefined;

      const result = await withSearchDeadline({ budgetMs, bookId: 3, log }, (signal) => {
        seen = signal;
        return Promise.resolve('ran');
      });

      expect(result).toBe('ran');
      expect(armed).toHaveLength(0);
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen!.aborted).toBe(false);
    });
  });

  describe('expiry', () => {
    it('rejects with SearchDeadlineError carrying the budget and book, with the signal aborted', async () => {
      const { armed } = captureTimer();
      const work = deferred<string>();
      let seen: AbortSignal | undefined;

      const raced = withSearchDeadline({ budgetMs: 900, bookId: 42, log }, (signal) => {
        seen = signal;
        return work.promise;
      });

      armed[0]!.fire();
      const error = await raced.catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SearchDeadlineError);
      expect((error as SearchDeadlineError).budgetMs).toBe(900);
      expect((error as SearchDeadlineError).bookId).toBe(42);
      expect((error as Error).constructor.name).toBe('SearchDeadlineError');
      expect(seen!.aborted).toBe(true);

      work.resolve('late');
      await flush();
    });

    it('propagates the work rejection when it loses no race', async () => {
      captureTimer();
      const boom = new Error('leaf exploded');

      await expect(withSearchDeadline({ budgetMs: 900, bookId: 5, log }, () => Promise.reject(boom)))
        .rejects.toBe(boom);
    });

    // AC4 / F20: the timer callback rejects BEFORE aborting, inverting the connector precedent.
    // A leaf that rejects synchronously from its own abort listener must not win the race.
    it('delivers the canonical deadline error even when a leaf rejects from its abort listener', async () => {
      const { armed } = captureTimer();
      const leafError = new Error('aborted by leaf');

      const raced = withSearchDeadline({ budgetMs: 900, bookId: 9, log }, (signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(leafError));
      }));

      armed[0]!.fire();
      const error = await raced.catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SearchDeadlineError);
      expect(error).not.toBe(leafError);
      await flush();
    });
  });

  describe('the late-outcome handler', () => {
    it('logs a late rejection at warn with the serialized error, bookId and budgetMs', async () => {
      const { armed } = captureTimer();
      const work = deferred<string>();
      const raced = withSearchDeadline({ budgetMs: 900, bookId: 11, log }, () => work.promise);

      armed[0]!.fire();
      await expect(raced).rejects.toBeInstanceOf(SearchDeadlineError);

      const failure = Object.assign(new Error('late boom'), { code: 'ELATE' });
      work.reject(failure);
      await flush();

      expect(log.warn).toHaveBeenCalledTimes(1);
      const [fields] = (log.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(fields).toMatchObject({ bookId: 11, budgetMs: 900 });
      const serialized = (fields as { error: Record<string, unknown> }).error;
      expect(serialized).not.toBeInstanceOf(Error);
      expect(Object.keys(serialized).sort()).toEqual(['code', 'message', 'stack', 'type']);
      expect(serialized.type).toBe('Error');
    });

    it('logs a late resolution at debug', async () => {
      const { armed } = captureTimer();
      const work = deferred<string>();
      const raced = withSearchDeadline({ budgetMs: 900, bookId: 12, log }, () => work.promise);

      armed[0]!.fire();
      await expect(raced).rejects.toBeInstanceOf(SearchDeadlineError);

      work.resolve('landed at last');
      await flush();

      expect(log.debug).toHaveBeenCalledTimes(1);
      expect((log.debug as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ bookId: 12, budgetMs: 900 });
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('does not log an outcome the race already delivered', async () => {
      captureTimer();

      await expect(withSearchDeadline({ budgetMs: 900, bookId: 13, log }, () => Promise.resolve('fast')))
        .resolves.toBe('fast');
      await expect(withSearchDeadline({ budgetMs: 900, bookId: 14, log }, () => Promise.reject(new Error('own'))))
        .rejects.toThrow('own');
      await flush();

      expect(log.debug).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('uses only the injected logger', async () => {
      const { armed } = captureTimer();
      const other = createMockLogger();
      const work = deferred<string>();
      const raced = withSearchDeadline({ budgetMs: 900, bookId: 15, log }, () => work.promise);

      armed[0]!.fire();
      await expect(raced).rejects.toBeInstanceOf(SearchDeadlineError);
      work.resolve('late');
      await flush();

      expect(log.debug).toHaveBeenCalledTimes(1);
      expect(other.debug).not.toHaveBeenCalled();
      expect(other.warn).not.toHaveBeenCalled();
    });
  });

  describe('the per-book registry', () => {
    it('runs fn once and skips concurrent same-book callers without arming their timers', async () => {
      const { armed } = captureTimer();
      const work = deferred<string>();
      const fn = vi.fn(() => work.promise);

      const first = withSearchDeadline({ budgetMs: 900, bookId: 21, log }, fn);
      const second = await withSearchDeadline({ budgetMs: 900, bookId: 21, log }, fn);
      const third = await withSearchDeadline({ budgetMs: 900, bookId: 21, log }, fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(second).toBeNull();
      expect(third).toBeNull();
      expect(armed).toHaveLength(1);

      armed[0]!.fire();
      await expect(first).rejects.toBeInstanceOf(SearchDeadlineError);

      // The accepted call's abandoned work still owns the slot after its deadline.
      expect(await withSearchDeadline({ budgetMs: 900, bookId: 21, log }, fn)).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);

      work.resolve('late');
      await flush();
    });

    it('holds exactly one entry no matter how many further callers arrive', async () => {
      captureTimer();
      const work = deferred<string>();
      const fn = vi.fn(() => work.promise);

      void withSearchDeadline({ budgetMs: 900, bookId: 22, log }, fn);
      for (let i = 0; i < 5; i++) {
        expect(await withSearchDeadline({ budgetMs: 900, bookId: 22, log }, fn)).toBeNull();
      }
      expect(fn).toHaveBeenCalledTimes(1);

      work.resolve('done');
      await flush();
    });

    it('does not skip a different book', async () => {
      const { armed } = captureTimer();
      const work = deferred<string>();
      const fn = vi.fn(() => work.promise);

      void withSearchDeadline({ budgetMs: 900, bookId: 23, log }, fn);
      const other = withSearchDeadline({ budgetMs: 900, bookId: 24, log }, () => Promise.resolve('other'));

      expect(fn).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(2);
      await expect(other).resolves.toBe('other');

      work.resolve('done');
      await flush();
    });

    it.each([
      ['resolves', (d: ReturnType<typeof deferred<string>>) => d.resolve('ok')],
      ['rejects', (d: ReturnType<typeof deferred<string>>) => d.reject(new Error('nope'))],
    ])('frees the slot when the operation %s before its deadline', async (_label, settle) => {
      captureTimer();
      const work = deferred<string>();
      const fn = vi.fn(() => work.promise);

      const first = withSearchDeadline({ budgetMs: 900, bookId: 25, log }, fn).catch(() => null);
      settle(work);
      await first;
      await flush();

      const second = await withSearchDeadline({ budgetMs: 900, bookId: 25, log }, () => Promise.resolve('second ran'));
      expect(second).toBe('second ran');
    });

    it.each([
      ['resolves', (d: ReturnType<typeof deferred<string>>) => d.resolve('ok')],
      ['rejects', (d: ReturnType<typeof deferred<string>>) => d.reject(new Error('nope'))],
    ])('frees the slot when the abandoned operation %s after its deadline', async (_label, settle) => {
      const { armed } = captureTimer();
      const work = deferred<string>();

      const first = withSearchDeadline({ budgetMs: 900, bookId: 26, log }, () => work.promise);
      armed[0]!.fire();
      await expect(first).rejects.toBeInstanceOf(SearchDeadlineError);

      settle(work);
      await flush();

      const second = await withSearchDeadline({ budgetMs: 900, bookId: 26, log }, () => Promise.resolve('second ran'));
      expect(second).toBe('second ran');
    });

    it('does not let an older operation evict a newer entry', async () => {
      captureTimer();
      const first = deferred<string>();
      const second = deferred<string>();

      const a = withSearchDeadline({ budgetMs: 900, bookId: 27, log }, () => first.promise);
      first.resolve('a');
      await a;
      await flush();

      void withSearchDeadline({ budgetMs: 900, bookId: 27, log }, () => second.promise);
      // The first operation's cleanup has already run; it must not have removed the second's slot.
      expect(await withSearchDeadline({ budgetMs: 900, bookId: 27, log }, () => Promise.resolve('third'))).toBeNull();

      second.resolve('b');
      await flush();
    });

    it('still reserves the slot when the outer guard is disabled', async () => {
      const { armed } = captureTimer();
      const work = deferred<string>();
      const fn = vi.fn(() => work.promise);

      void withSearchDeadline({ budgetMs: 0, bookId: 28, log }, fn);
      expect(await withSearchDeadline({ budgetMs: 0, bookId: 28, log }, fn)).toBeNull();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(0);

      work.resolve('done');
      await flush();
    });
  });

  describe('unhandled rejections', () => {
    it('stay silent across abandoned and self-rejecting work', async () => {
      const { armed } = captureTimer();
      const seen: unknown[] = [];
      const listener = (reason: unknown) => seen.push(reason);
      process.on('unhandledRejection', listener);
      try {
        const work = deferred<string>();
        const raced = withSearchDeadline({ budgetMs: 900, bookId: 31, log }, () => work.promise);
        armed[0]!.fire();
        await expect(raced).rejects.toBeInstanceOf(SearchDeadlineError);
        work.reject(new Error('abandoned failure'));
        await flush();
        await flush();
      } finally {
        process.off('unhandledRejection', listener);
      }
      expect(seen).toEqual([]);
    });
  });
});
