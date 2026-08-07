/**
 * #1942 — the chapter-corroboration owner: cache classification, single-flight,
 * throttle/backoff bridge, and the lazy trigger.
 *
 * The load-bearing property under test is NOT "does it return the right number"
 * but "does the right thing SETTLE". A cached verdict means the rescuable book
 * never retries, so a transient outcome (a rate-limit page, an auth-proxy 403, a
 * wrong-edition body) that settles as `no usable runtime` would permanently
 * re-break the false positive this feature exists to fix. Every case therefore
 * asserts BOTH the returned value AND the HTTP call count on a second lookup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { ChapterRuntimeOutcome } from '@core/index.js';
import {
  createChapterCorroborator,
  corroborateDurationVerdict,
  type ChapterCorroborator,
} from './chapter-corroboration.js';
import type { ChapterRuntimeSeconds, DurationConfidenceResult } from './match-job.helpers.js';

const ASIN = 'B00CXXEX8W';
/** Fablehaven Book 1's live chapter runtime (2026-07-25). */
const FABLEHAVEN_MS = 33219490;

/**
 * The requested edition's complete record. Defaults model a table with NO
 * trimmable tail (#2168): the trim contributes nothing and both references carry
 * the same value, which is the non-regression shape (AC30/AC31).
 */
function completeRecord(overrides: Partial<Extract<ChapterRuntimeOutcome, { kind: 'ok' }>> = {}): ChapterRuntimeOutcome {
  return {
    kind: 'ok',
    runtimeLengthMs: FABLEHAVEN_MS,
    isAccurate: true,
    trimmedRuntimeMs: FABLEHAVEN_MS,
    trimmedChapterCount: 0,
    ...overrides,
  };
}

/** A record whose trailing promotional run WAS removed, leaving a distinct runtime. */
function trimmedRecord(overrides: Partial<Extract<ChapterRuntimeOutcome, { kind: 'ok' }>> = {}): ChapterRuntimeOutcome {
  return completeRecord({ runtimeLengthMs: 86_400_000, trimmedRuntimeMs: 85_134_000, trimmedChapterCount: 1, ...overrides });
}

/** The "nothing usable" shape every miss returns — one representation, never `undefined`. */
const NONE = {};
/** Fablehaven's references: no trimmable tail, so both carry the same value. */
const FABLEHAVEN_REFS = { fullSeconds: 33219.49, trimmedSeconds: 33219.49 };

interface Harness {
  corroborator: ChapterCorroborator;
  getChapterRuntime: ReturnType<typeof vi.fn>;
  acquireThrottle: ReturnType<typeof vi.fn>;
  setRateLimited: ReturnType<typeof vi.fn>;
  rateLimited: { value: boolean };
}

function makeHarness(providerName = 'Audnexus'): Harness {
  const getChapterRuntime = vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>();
  const acquireThrottle = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const setRateLimited = vi.fn();
  const rateLimited = { value: false };
  const corroborator = createChapterCorroborator({
    provider: { name: providerName, getChapterRuntime },
    log: inject<FastifyBaseLogger>(createMockLogger()),
    acquireThrottle,
    isRateLimited: () => rateLimited.value,
    getRateLimitRemainingMs: () => (rateLimited.value ? 30_000 : 0),
    setRateLimited,
  });
  return { corroborator, getChapterRuntime, acquireThrottle, setRateLimited, rateLimited };
}

describe('createChapterCorroborator — trust gate (D3/AC5)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('a complete record with isAccurate true and a positive runtime converts ms → SECONDS', async () => {
    h.getChapterRuntime.mockResolvedValue(completeRecord());

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN))
      .resolves.toEqual({ fullSeconds: 33219.49, trimmedSeconds: 33219.49 });
  });

  it('#2168 — a trimmed record yields BOTH references, each converted ms → SECONDS', async () => {
    h.getChapterRuntime.mockResolvedValue(trimmedRecord());

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN))
      .resolves.toEqual({ fullSeconds: 86_400, trimmedSeconds: 85_134 });
  });

  it.each([
    ['isAccurate false', completeRecord({ isAccurate: false })],
    ['isAccurate null', completeRecord({ isAccurate: null })],
    ['isAccurate absent', { kind: 'ok', runtimeLengthMs: FABLEHAVEN_MS, isAccurate: undefined, trimmedRuntimeMs: FABLEHAVEN_MS, trimmedChapterCount: 0 } as ChapterRuntimeOutcome],
    ['runtimeLengthMs null', completeRecord({ runtimeLengthMs: null, trimmedRuntimeMs: undefined })],
    ['runtimeLengthMs zero', completeRecord({ runtimeLengthMs: 0, trimmedRuntimeMs: 0 })],
    ['runtimeLengthMs negative', completeRecord({ runtimeLengthMs: -1000, trimmedRuntimeMs: -1000 })],
    ['runtimeLengthMs non-finite', completeRecord({ runtimeLengthMs: Number.POSITIVE_INFINITY, trimmedRuntimeMs: Number.POSITIVE_INFINITY })],
  ])('%s → no usable runtime, and it SETTLES (a second lookup issues no request)', async (_label, outcome) => {
    h.getChapterRuntime.mockResolvedValue(outcome);

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);
  });

  /**
   * #2168 AC15 — `usableChapterSeconds` is the ONE validity gate, applied
   * IDENTICALLY to both references. The pure trim rule returns these values raw
   * (its unit tests pin that); the rejection happens here and nowhere else.
   */
  it.each([
    ['zero', 0],
    ['negative', -5_000],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('a degenerate NUMERIC trimmedRuntimeMs (%s) yields NO trimmed reference while the full one survives', async (_label, trimmedRuntimeMs) => {
    h.getChapterRuntime.mockResolvedValue(completeRecord({ trimmedRuntimeMs, trimmedChapterCount: 1 }));

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 33219.49 });
  });

  it('a trimmedRuntimeMs the rule refused (undefined) yields the full reference alone', async () => {
    h.getChapterRuntime.mockResolvedValue(completeRecord({ trimmedRuntimeMs: undefined, trimmedChapterCount: 3 }));

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 33219.49 });
  });

  it('a provider-declared-INACCURATE table suppresses BOTH references, not just the full one', async () => {
    h.getChapterRuntime.mockResolvedValue(trimmedRecord({ isAccurate: false }));

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
  });
});

describe('createChapterCorroborator — the settle diagnostic (#2168 AC16/AC22)', () => {
  it('a settled ok logs the trimmed runtime AND the count alongside the full one', async () => {
    const log = createMockLogger();
    const getChapterRuntime = vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>()
      .mockResolvedValue(trimmedRecord({ trimmedChapterCount: 2 }));
    const corroborator = createChapterCorroborator({
      provider: { name: 'Audnexus', getChapterRuntime },
      log: inject<FastifyBaseLogger>(log),
      acquireThrottle: () => Promise.resolve(),
      isRateLimited: () => false,
      getRateLimitRemainingMs: () => 0,
      setRateLimited: vi.fn(),
    });

    await corroborator.getChapterRuntimeSeconds(ASIN);

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        asin: ASIN,
        chapterSeconds: 86_400,
        trimmedRuntimeMs: 85_134_000,
        trimmedChapterSeconds: 85_134,
        trimmedChapterCount: 2,
      }),
      expect.stringContaining('settled'),
    );
  });

  it('a trusted ZERO-LENGTH trailing match logs a count of 1 even though the two runtimes are equal', async () => {
    // Counterfactual: derive the logged count from `trimmed !== full` and this
    // reads 0. The count is the ADAPTER's, never re-derived (AC2/AC22).
    const log = createMockLogger();
    const getChapterRuntime = vi.fn<(asin: string) => Promise<ChapterRuntimeOutcome>>()
      .mockResolvedValue(completeRecord({ trimmedChapterCount: 1 }));
    const corroborator = createChapterCorroborator({
      provider: { name: 'Audnexus', getChapterRuntime },
      log: inject<FastifyBaseLogger>(log),
      acquireThrottle: () => Promise.resolve(),
      isRateLimited: () => false,
      getRateLimitRemainingMs: () => 0,
      setRateLimited: vi.fn(),
    });

    await corroborator.getChapterRuntimeSeconds(ASIN);

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ trimmedChapterCount: 1, chapterSeconds: 33219.49, trimmedChapterSeconds: 33219.49 }),
      expect.stringContaining('settled'),
    );
  });

  it('the count never enters the cache or the return value — two settles differing only in count are indistinguishable', async () => {
    const withCount = makeHarness();
    const withoutCount = makeHarness();
    withCount.getChapterRuntime.mockResolvedValue(trimmedRecord({ trimmedChapterCount: 2 }));
    withoutCount.getChapterRuntime.mockResolvedValue(trimmedRecord({ trimmedChapterCount: 0 }));

    const a = await withCount.corroborator.getChapterRuntimeSeconds(ASIN);
    const b = await withoutCount.corroborator.getChapterRuntimeSeconds(ASIN);

    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(['fullSeconds', 'trimmedSeconds']);
    // ...and a cache HIT emits no count at all, exactly as it emits no log line today.
    expect(await withCount.corroborator.getChapterRuntimeSeconds(ASIN)).toEqual(a);
    expect(withCount.getChapterRuntime).toHaveBeenCalledTimes(1);
  });
});

describe('createChapterCorroborator — cache matrix (AC2)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  describe('definitive — settles, so a second lookup issues NO request', () => {
    it('the requested edition\'s complete record with a usable runtime', async () => {
      h.getChapterRuntime.mockResolvedValue(completeRecord());

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);
      expect(h.acquireThrottle).toHaveBeenCalledTimes(1);
    });

    it('not_found (the documented HTTP 400/404 — Audnexus asserts the ASIN is absent)', async () => {
      h.getChapterRuntime.mockResolvedValue({ kind: 'not_found' });

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);
    });
  });

  describe('transient — never settles, so a later call re-requests and a success promotes', () => {
    it.each([
      ['invalid_record (a 200 that is not this edition\'s complete record)', { kind: 'invalid_record', reason: 'asin-mismatch' } as ChapterRuntimeOutcome],
      ['invalid_record (fieldless/error envelope)', { kind: 'invalid_record', reason: 'schema-invalid' } as ChapterRuntimeOutcome],
      ['transient_failure (pre-header network / 5xx / 401 / 202 / redirect)', { kind: 'transient_failure', message: 'HTTP 503' } as ChapterRuntimeOutcome],
      ['rate_limited (429)', { kind: 'rate_limited', retryAfterMs: 1 } as ChapterRuntimeOutcome],
    ])('%s → not cached; the next call re-requests and a valid record then promotes AND settles', async (_label, outcome) => {
      h.getChapterRuntime.mockResolvedValue(outcome);

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(2);

      h.getChapterRuntime.mockResolvedValue(completeRecord());
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(3);

      // ...and the promotion settles: a fourth lookup issues no request.
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(3);
    });

    it('a wrong-edition chapter body can never settle as a verdict about the requested ASIN', async () => {
      // The adapter already refuses to hand back another edition's runtime; this
      // pins that the owner does not cache the resulting `invalid_record` either.
      h.getChapterRuntime.mockResolvedValue({ kind: 'invalid_record', reason: 'asin-mismatch' });

      await h.corroborator.getChapterRuntimeSeconds(ASIN);
      h.getChapterRuntime.mockResolvedValue(completeRecord());

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
    });
  });
});

describe('createChapterCorroborator — throttle and provider-wide backoff (AC4)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('acquires the shared throttle before every provider call — never a direct unthrottled call', async () => {
    const order: string[] = [];
    h.acquireThrottle.mockImplementation(() => { order.push('throttle'); return Promise.resolve(); });
    h.getChapterRuntime.mockImplementation(() => { order.push('fetch'); return Promise.resolve(completeRecord()); });

    await h.corroborator.getChapterRuntimeSeconds(ASIN);

    expect(order).toEqual(['throttle', 'fetch']);
  });

  it('honors an ACTIVE provider-wide backoff — no throttle slot, no request', async () => {
    h.rateLimited.value = true;

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);

    expect(h.getChapterRuntime).not.toHaveBeenCalled();
    expect(h.acquireThrottle).not.toHaveBeenCalled();
  });

  it('a skipped-because-rate-limited lookup does NOT settle — it retries once the window clears', async () => {
    h.rateLimited.value = true;
    await h.corroborator.getChapterRuntimeSeconds(ASIN);

    h.rateLimited.value = false;
    h.getChapterRuntime.mockResolvedValue(completeRecord());
    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
  });

  it('a RETURNED 429 feeds its finite window back into the shared backoff gate (F11/F16)', async () => {
    h.getChapterRuntime.mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 45_000 });

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);

    expect(h.setRateLimited).toHaveBeenCalledWith('Audnexus', 45_000);
    const [, windowMs] = h.setRateLimited.mock.calls[0]!;
    expect(Number.isFinite(windowMs)).toBe(true);
    expect(windowMs).toBeGreaterThanOrEqual(0);
  });

  it('does not touch the backoff gate for any non-429 outcome', async () => {
    h.getChapterRuntime.mockResolvedValue({ kind: 'transient_failure', message: 'boom' });

    await h.corroborator.getChapterRuntimeSeconds(ASIN);

    expect(h.setRateLimited).not.toHaveBeenCalled();
  });
});

describe('createChapterCorroborator — single-flight (AC2)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('concurrent same-ASIN misses share ONE throttle acquisition and ONE request', async () => {
    let release!: (o: ChapterRuntimeOutcome) => void;
    h.getChapterRuntime.mockReturnValue(new Promise<ChapterRuntimeOutcome>(resolve => { release = resolve; }));

    const all = Promise.all([
      h.corroborator.getChapterRuntimeSeconds(ASIN),
      h.corroborator.getChapterRuntimeSeconds(ASIN),
      h.corroborator.getChapterRuntimeSeconds(ASIN),
    ]);
    release(completeRecord());

    expect(await all).toEqual([FABLEHAVEN_REFS, FABLEHAVEN_REFS, FABLEHAVEN_REFS]);
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);
    expect(h.acquireThrottle).toHaveBeenCalledTimes(1);
  });

  it('concurrent misses on DIFFERENT ASINs are not coalesced', async () => {
    h.getChapterRuntime.mockResolvedValue(completeRecord());

    await Promise.all([
      h.corroborator.getChapterRuntimeSeconds(ASIN),
      h.corroborator.getChapterRuntimeSeconds('B_OTHER'),
    ]);

    expect(h.getChapterRuntime).toHaveBeenCalledTimes(2);
  });

  it('concurrent misses that resolve TRANSIENT share the outcome and leave no cache entry', async () => {
    let release!: (o: ChapterRuntimeOutcome) => void;
    h.getChapterRuntime.mockReturnValueOnce(new Promise<ChapterRuntimeOutcome>(resolve => { release = resolve; }));

    const all = Promise.all([
      h.corroborator.getChapterRuntimeSeconds(ASIN),
      h.corroborator.getChapterRuntimeSeconds(ASIN),
    ]);
    release({ kind: 'transient_failure', message: 'socket hang up' });
    expect(await all).toEqual([NONE, NONE]);
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);

    h.getChapterRuntime.mockResolvedValue(completeRecord());
    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(2);
  });

  it('never rejects — a throwing throttle degrades to "no usable runtime" (AC9)', async () => {
    h.acquireThrottle.mockRejectedValue(new Error('throttle exploded'));

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
  });
});

describe('createChapterCorroborator — owner-instance isolation (F14/AC2)', () => {
  it('two owners built for different regions each perform and cache their OWN lookup', async () => {
    const us = makeHarness();
    const uk = makeHarness();
    us.getChapterRuntime.mockResolvedValue(completeRecord());
    uk.getChapterRuntime.mockResolvedValue(completeRecord({ runtimeLengthMs: 30000000, trimmedRuntimeMs: 30000000 }));

    await expect(us.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(FABLEHAVEN_REFS);
    await expect(uk.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 30000, trimmedSeconds: 30000 });

    // Each settled independently — neither reused the other's verdict.
    expect(us.getChapterRuntime).toHaveBeenCalledTimes(1);
    expect(uk.getChapterRuntime).toHaveBeenCalledTimes(1);
    await us.corroborator.getChapterRuntimeSeconds(ASIN);
    await uk.corroborator.getChapterRuntimeSeconds(ASIN);
    expect(us.getChapterRuntime).toHaveBeenCalledTimes(1);
    expect(uk.getChapterRuntime).toHaveBeenCalledTimes(1);
  });
});

describe('corroborateDurationVerdict — lazy trigger (AC4/AC7/AC9)', () => {
  const MISMATCH: DurationConfidenceResult = {
    confidence: 'medium',
    reason: 'Duration mismatch — scanned 9h 13m vs expected 8h 59m',
    reasonKind: 'duration-mismatch',
  };
  const HIGH: DurationConfidenceResult = { confidence: 'high' };

  let lookupChapterSeconds: ReturnType<typeof vi.fn<(asin: string) => Promise<ChapterRuntimeSeconds>>>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    lookupChapterSeconds = vi.fn().mockResolvedValue(FABLEHAVEN_REFS);
    log = createMockLogger();
  });

  function run(verdict: DurationConfidenceResult, asin: string | undefined, recheck = (_refs: ChapterRuntimeSeconds): DurationConfidenceResult => HIGH) {
    return corroborateDurationVerdict({
      verdict,
      asin,
      path: '/audiobooks/Fablehaven',
      log: inject<FastifyBaseLogger>(log),
      lookupChapterSeconds,
      recheck,
    });
  }

  it.each([
    ['a scalar-VERIFIED match', HIGH],
    ['an ambiguity-class review', { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate', reasonKind: 'no-duration-data' } as DurationConfidenceResult],
    ['a missing-duration review', { confidence: 'medium', reason: 'Best match missing duration — cannot verify', reasonKind: 'missing-duration' } as DurationConfidenceResult],
    ['a cap-synthesized reason with no kind', { confidence: 'medium', reason: 'Low confidence match. Please verify.' } as DurationConfidenceResult],
  ])('%s issues ZERO chapter lookups and is returned untouched', async (_label, verdict) => {
    const result = await run(verdict, ASIN);

    expect(lookupChapterSeconds).not.toHaveBeenCalled();
    expect(result).toEqual({ verdict, chapterRuntimes: NONE });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('a duration mismatch whose ASIN is %s issues ZERO lookups and keeps the scalar verdict', async (_label, asin) => {
    const result = await run(MISMATCH, asin);

    expect(lookupChapterSeconds).not.toHaveBeenCalled();
    expect(result).toEqual({ verdict: MISMATCH, chapterRuntimes: NONE });
  });

  it('a qualifying mismatch issues exactly ONE lookup and promotes on a usable in-band runtime', async () => {
    const result = await run(MISMATCH, ASIN);

    expect(lookupChapterSeconds).toHaveBeenCalledExactlyOnceWith(ASIN);
    expect(result.verdict).toEqual(HIGH);
    expect(result.chapterRuntimes).toEqual(FABLEHAVEN_REFS);
  });

  it('#2168 — a TRIMMED-ONLY reference still triggers the recheck, and rides back out for the cap signal', async () => {
    // The reference set the verdict was promoted with must reach the caller, or
    // the recomputed `durationVerified` would be false and the caps would demote
    // the row straight back (AC23).
    lookupChapterSeconds.mockResolvedValue({ trimmedSeconds: 85_134 });
    const recheck = vi.fn(() => HIGH);

    const result = await run(MISMATCH, ASIN, recheck);

    expect(recheck).toHaveBeenCalledExactlyOnceWith({ trimmedSeconds: 85_134 });
    expect(result).toEqual({ verdict: HIGH, chapterRuntimes: { trimmedSeconds: 85_134 } });
  });

  it('#2168 — the settle-time debug line names both references', async () => {
    lookupChapterSeconds.mockResolvedValue({ fullSeconds: 86_400, trimmedSeconds: 85_134 });

    await run(MISMATCH, ASIN);

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ asin: ASIN, chapterSeconds: 86_400, trimmedChapterSeconds: 85_134, promoted: true }),
      expect.stringContaining('corroboration applied'),
    );
  });

  it('trims the ASIN before looking it up', async () => {
    await run(MISMATCH, `  ${ASIN}  `);

    expect(lookupChapterSeconds).toHaveBeenCalledWith(ASIN);
  });

  it('suppress-only: an OUT-OF-BAND chapter runtime leaves the mismatch standing', async () => {
    const result = await run(MISMATCH, ASIN, () => MISMATCH);

    expect(result.verdict).toEqual(MISMATCH);
  });

  it('no usable chapter runtime (NEITHER reference) → the scalar verdict stands and the recheck never runs', async () => {
    lookupChapterSeconds.mockResolvedValue(NONE);
    const recheck = vi.fn(() => HIGH);

    const result = await run(MISMATCH, ASIN, recheck);

    expect(recheck).not.toHaveBeenCalled();
    expect(result).toEqual({ verdict: MISMATCH, chapterRuntimes: NONE });
  });

  it('AC9 — a rejecting lookup never escapes: it degrades to the scalar verdict and logs at debug', async () => {
    lookupChapterSeconds.mockRejectedValue(new Error('chapters blew up'));

    const result = await run(MISMATCH, ASIN);

    expect(result).toEqual({ verdict: MISMATCH, chapterRuntimes: NONE });
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ asin: ASIN }),
      expect.stringContaining('keeping the scalar duration verdict'),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
