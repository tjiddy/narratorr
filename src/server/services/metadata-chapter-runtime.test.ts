import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { ChapterRuntimeOutcome } from '../../core/metadata/audnexus.js';
import { lookupChapterRuntimeMs, type ChapterRuntimeDeps } from './metadata-chapter-runtime.js';

const log = inject<FastifyBaseLogger>(createMockLogger());

/** A resolvable promise handle — the deterministic throttle barrier (F2). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeDeps(
  overrides: Partial<ChapterRuntimeDeps> & { getChaptersDetailed: ChapterRuntimeDeps['audnexus']['getChaptersDetailed'] },
): ChapterRuntimeDeps {
  const { getChaptersDetailed, ...rest } = overrides;
  return {
    audnexus: { name: 'Audnexus', getChaptersDetailed },
    log,
    acquireThrottle: async () => {},
    isRateLimited: () => false,
    setRateLimited: () => {},
    ...rest,
  };
}

// #1932 (F2) — the two-point-backoff lookup, tested deterministically with a
// controllable `acquireThrottle` barrier and injected rate-limit state. No real
// wall clock or `RequestThrottle` timing is exercised, so the post-acquire re-check
// signal cannot flip on host scheduling.
describe('lookupChapterRuntimeMs (#1932)', () => {
  it('returns the usable ok milliseconds', async () => {
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => ({ kind: 'ok', runtimeMs: 33219490 }));
    expect(await lookupChapterRuntimeMs(makeDeps({ getChaptersDetailed: adapter }), 'B00CXXEX8W')).toBe(33219490);
    expect(adapter).toHaveBeenCalledWith('B00CXXEX8W');
  });

  it('maps a valid-but-unusable ok (runtimeMs null) to null', async () => {
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => ({ kind: 'ok', runtimeMs: null }));
    expect(await lookupChapterRuntimeMs(makeDeps({ getChaptersDetailed: adapter }), 'B_X')).toBeNull();
  });

  it('active backoff on entry → null, no provider call, throttle never acquired', async () => {
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => ({ kind: 'ok', runtimeMs: 100 }));
    const acquireThrottle = vi.fn(async () => {});
    const deps = makeDeps({ getChaptersDetailed: adapter, isRateLimited: () => true, acquireThrottle });

    expect(await lookupChapterRuntimeMs(deps, 'B_BLOCKED')).toBeNull();
    expect(adapter).not.toHaveBeenCalled();
    expect(acquireThrottle).not.toHaveBeenCalled();
  });

  it('fresh 429 records shared backoff before returning null', async () => {
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => ({ kind: 'rate_limited', retryAfterMs: 60_000 }));
    const setRateLimited = vi.fn();
    const deps = makeDeps({ getChaptersDetailed: adapter, setRateLimited });

    expect(await lookupChapterRuntimeMs(deps, 'B_429')).toBeNull();
    expect(setRateLimited).toHaveBeenCalledWith('Audnexus', 60_000);
  });

  it('non-rate failure/miss → null, backoff untouched', async () => {
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => ({ kind: 'transient_failure', message: 'boom' }));
    const setRateLimited = vi.fn();
    expect(await lookupChapterRuntimeMs(makeDeps({ getChaptersDetailed: adapter, setRateLimited }), 'B_T')).toBeNull();
    expect(setRateLimited).not.toHaveBeenCalled();
  });

  it('never throws even if the adapter throws', async () => {
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => { throw new Error('surprise'); });
    await expect(lookupChapterRuntimeMs(makeDeps({ getChaptersDetailed: adapter }), 'B_THROW')).resolves.toBeNull();
  });

  // The overlap the pre-acquire-only sequence misses (F11/F2): B passes its ENTRY
  // check while no backoff exists, then blocks in `acquireThrottle`. A completes,
  // seeds backoff via `setRateLimited`. B is released and its SECOND (post-acquire)
  // `isRateLimited` check now short-circuits — the adapter runs exactly once (for A).
  it('post-acquire re-check keeps a queued sibling out of the adapter (deterministic barrier)', async () => {
    const limited = { value: false };
    const adapter = vi.fn(async (): Promise<ChapterRuntimeOutcome> => ({ kind: 'rate_limited', retryAfterMs: 60_000 }));
    const shared = {
      getChaptersDetailed: adapter,
      isRateLimited: () => limited.value,
      setRateLimited: vi.fn(() => { limited.value = true; }),
    };

    const bBarrier = deferred<void>();
    const depsA = makeDeps({ ...shared, acquireThrottle: async () => {} });
    const depsB = makeDeps({ ...shared, acquireThrottle: () => bBarrier.promise });

    // B starts first: entry check passes (limited false), then it awaits the barrier.
    const pB = lookupChapterRuntimeMs(depsB, 'B_B');
    await Promise.resolve(); // let B reach the throttle await

    // A runs to completion — its 429 seeds the shared backoff.
    expect(await lookupChapterRuntimeMs(depsA, 'B_A')).toBeNull();
    expect(limited.value).toBe(true);

    // Release B; its post-acquire re-check now sees the backoff and skips the call.
    bBarrier.resolve();
    expect(await pB).toBeNull();

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledWith('B_A');
  });
});
