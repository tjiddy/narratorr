import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { fetchChapterRuntimeMs, type ChapterRuntimeDeps } from './metadata-chapter-runtime.js';
import type { ChapterRuntimeOutcome } from '../../core/index.js';

/**
 * Controlled-dependency tests for the extracted chapter-runtime lookup (#1934 F5).
 * Stubbing `ChapterRuntimeDeps` lets each of the two shared-backoff guards be
 * pinned INDEPENDENTLY — impossible at the service-integration layer, where a
 * single `rateLimitUntil` map + `Date.now()` drives both `isRateLimited` calls.
 * These are also clock-free by construction (no `Date.now()` in the stubs).
 */
function makeDeps(overrides: Partial<ChapterRuntimeDeps> = {}) {
  const deps: ChapterRuntimeDeps = {
    acquireThrottle: vi.fn().mockResolvedValue(undefined),
    getChaptersDetailed: vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>()
      .mockResolvedValue({ kind: 'ok', runtimeMs: 33219490 }),
    setRateLimited: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    log: inject<FastifyBaseLogger>(createMockLogger()),
    ...overrides,
  };
  // Pull the spy handles off the FINAL deps object so overrides are reflected.
  return {
    deps,
    acquireThrottle: vi.mocked(deps.acquireThrottle),
    getChaptersDetailed: vi.mocked(deps.getChaptersDetailed),
    setRateLimited: vi.mocked(deps.setRateLimited),
    isRateLimited: vi.mocked(deps.isRateLimited),
  };
}

describe('fetchChapterRuntimeMs — shared-backoff guards (#1934 F5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PRE-throttle guard: backoff active at entry → skips throttle AND provider, returns null', async () => {
    const { deps, acquireThrottle, getChaptersDetailed, isRateLimited } = makeDeps({
      isRateLimited: vi.fn().mockReturnValue(true),
    });

    const result = await fetchChapterRuntimeMs(deps, 'B00CXXEX8W');

    expect(result).toBeNull();
    expect(isRateLimited).toHaveBeenCalledExactlyOnceWith('Audnexus');
    // Deletion-sensitive: removing the pre-throttle fast path lets execution reach
    // acquireThrottle (and the provider), failing these negative assertions.
    expect(acquireThrottle).not.toHaveBeenCalled();
    expect(getChaptersDetailed).not.toHaveBeenCalled();
  });

  it('POST-throttle guard: false at entry, true after acquisition → acquires throttle, skips provider, returns null', async () => {
    // A sibling lookup seeds backoff while this call is queued on the throttle.
    const isRateLimited = vi.fn()
      .mockReturnValueOnce(false)  // pre-throttle: proceed
      .mockReturnValueOnce(true);  // post-throttle: sibling seeded backoff
    const { deps, acquireThrottle, getChaptersDetailed } = makeDeps({ isRateLimited });

    const result = await fetchChapterRuntimeMs(deps, 'B00CXXEX8W');

    expect(result).toBeNull();
    expect(isRateLimited).toHaveBeenCalledTimes(2);
    expect(acquireThrottle).toHaveBeenCalledOnce();
    // Deletion-sensitive: removing the post-throttle re-check lets the provider be
    // hit after a sibling established backoff, failing this negative assertion.
    expect(getChaptersDetailed).not.toHaveBeenCalled();
  });

  it('no backoff (false at entry AND after acquisition) → acquires throttle, calls provider, returns runtime', async () => {
    const isRateLimited = vi.fn().mockReturnValue(false);
    const { deps, acquireThrottle, getChaptersDetailed } = makeDeps({ isRateLimited });

    const result = await fetchChapterRuntimeMs(deps, 'B00CXXEX8W');

    expect(result).toBe(33219490);
    expect(isRateLimited).toHaveBeenCalledTimes(2); // both guards evaluated
    expect(acquireThrottle).toHaveBeenCalledOnce();
    expect(getChaptersDetailed).toHaveBeenCalledExactlyOnceWith('B00CXXEX8W');
  });

  it('seeds shared backoff from a rate_limited outcome and returns null', async () => {
    const getChaptersDetailed = vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>()
      .mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 60000 });
    const { deps, setRateLimited } = makeDeps({ getChaptersDetailed });

    const result = await fetchChapterRuntimeMs(deps, 'B00CXXEX8W');

    expect(result).toBeNull();
    expect(setRateLimited).toHaveBeenCalledExactlyOnceWith('Audnexus', 60000);
  });

  it.each(['not_found', 'invalid_record', 'transient_failure'] as const)(
    'returns null and does NOT seed backoff on a %s outcome',
    async (kind) => {
      const getChaptersDetailed = vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>()
        .mockResolvedValue({ kind, message: 'x' } as ChapterRuntimeOutcome);
      const { deps, setRateLimited } = makeDeps({ getChaptersDetailed });

      expect(await fetchChapterRuntimeMs(deps, 'B_FAIL')).toBeNull();
      expect(setRateLimited).not.toHaveBeenCalled();
    },
  );

  it('a provider throw degrades to null (never escapes) and does NOT seed backoff', async () => {
    const getChaptersDetailed = vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>()
      .mockRejectedValue(new Error('boom'));
    const { deps, setRateLimited } = makeDeps({ getChaptersDetailed });

    await expect(fetchChapterRuntimeMs(deps, 'B_THROW')).resolves.toBeNull();
    expect(setRateLimited).not.toHaveBeenCalled();
  });
});
