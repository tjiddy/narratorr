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
import type { ChapterRuntimeOutcome } from '../../core/index.js';
import {
  createChapterCorroborator,
  corroborateDurationVerdict,
  type ChapterCorroborator,
} from './chapter-corroboration.js';
import type { DurationConfidenceResult } from './match-job.helpers.js';

const ASIN = 'B00CXXEX8W';
/** Fablehaven Book 1's live chapter runtime (2026-07-25). */
const FABLEHAVEN_MS = 33219490;

function completeRecord(overrides: Partial<Extract<ChapterRuntimeOutcome, { kind: 'ok' }>> = {}): ChapterRuntimeOutcome {
  return { kind: 'ok', runtimeLengthMs: FABLEHAVEN_MS, isAccurate: true, ...overrides };
}

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

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
  });

  it.each([
    ['isAccurate false', completeRecord({ isAccurate: false })],
    ['isAccurate null', completeRecord({ isAccurate: null })],
    ['isAccurate absent', { kind: 'ok', runtimeLengthMs: FABLEHAVEN_MS, isAccurate: undefined } as ChapterRuntimeOutcome],
    ['runtimeLengthMs null', completeRecord({ runtimeLengthMs: null })],
    ['runtimeLengthMs zero', completeRecord({ runtimeLengthMs: 0 })],
    ['runtimeLengthMs negative', completeRecord({ runtimeLengthMs: -1000 })],
    ['runtimeLengthMs non-finite', completeRecord({ runtimeLengthMs: Number.POSITIVE_INFINITY })],
  ])('%s → no usable runtime, and it SETTLES (a second lookup issues no request)', async (_label, outcome) => {
    h.getChapterRuntime.mockResolvedValue(outcome);

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);
  });
});

describe('createChapterCorroborator — cache matrix (AC2)', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  describe('definitive — settles, so a second lookup issues NO request', () => {
    it('the requested edition\'s complete record with a usable runtime', async () => {
      h.getChapterRuntime.mockResolvedValue(completeRecord());

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);
      expect(h.acquireThrottle).toHaveBeenCalledTimes(1);
    });

    it('not_found (the documented HTTP 400/404 — Audnexus asserts the ASIN is absent)', async () => {
      h.getChapterRuntime.mockResolvedValue({ kind: 'not_found' });

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
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

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(2);

      h.getChapterRuntime.mockResolvedValue(completeRecord());
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(3);

      // ...and the promotion settles: a fourth lookup issues no request.
      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
      expect(h.getChapterRuntime).toHaveBeenCalledTimes(3);
    });

    it('a wrong-edition chapter body can never settle as a verdict about the requested ASIN', async () => {
      // The adapter already refuses to hand back another edition's runtime; this
      // pins that the owner does not cache the resulting `invalid_record` either.
      h.getChapterRuntime.mockResolvedValue({ kind: 'invalid_record', reason: 'asin-mismatch' });

      await h.corroborator.getChapterRuntimeSeconds(ASIN);
      h.getChapterRuntime.mockResolvedValue(completeRecord());

      await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
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

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();

    expect(h.getChapterRuntime).not.toHaveBeenCalled();
    expect(h.acquireThrottle).not.toHaveBeenCalled();
  });

  it('a skipped-because-rate-limited lookup does NOT settle — it retries once the window clears', async () => {
    h.rateLimited.value = true;
    await h.corroborator.getChapterRuntimeSeconds(ASIN);

    h.rateLimited.value = false;
    h.getChapterRuntime.mockResolvedValue(completeRecord());
    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
  });

  it('a RETURNED 429 feeds its finite window back into the shared backoff gate (F11/F16)', async () => {
    h.getChapterRuntime.mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 45_000 });

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();

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

    expect(await all).toEqual([33219.49, 33219.49, 33219.49]);
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
    expect(await all).toEqual([undefined, undefined]);
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(1);

    h.getChapterRuntime.mockResolvedValue(completeRecord());
    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
    expect(h.getChapterRuntime).toHaveBeenCalledTimes(2);
  });

  it('never rejects — a throwing throttle degrades to "no usable runtime" (AC9)', async () => {
    h.acquireThrottle.mockRejectedValue(new Error('throttle exploded'));

    await expect(h.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBeUndefined();
  });
});

describe('createChapterCorroborator — owner-instance isolation (F14/AC2)', () => {
  it('two owners built for different regions each perform and cache their OWN lookup', async () => {
    const us = makeHarness();
    const uk = makeHarness();
    us.getChapterRuntime.mockResolvedValue(completeRecord());
    uk.getChapterRuntime.mockResolvedValue(completeRecord({ runtimeLengthMs: 30000000 }));

    await expect(us.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(33219.49);
    await expect(uk.corroborator.getChapterRuntimeSeconds(ASIN)).resolves.toBe(30000);

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

  let lookupChapterSeconds: ReturnType<typeof vi.fn<(asin: string) => Promise<number | undefined>>>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    lookupChapterSeconds = vi.fn().mockResolvedValue(33219.49);
    log = createMockLogger();
  });

  function run(verdict: DurationConfidenceResult, asin: string | undefined, recheck = (_cs: number): DurationConfidenceResult => HIGH) {
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
    expect(result).toEqual({ verdict });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('a duration mismatch whose ASIN is %s issues ZERO lookups and keeps the scalar verdict', async (_label, asin) => {
    const result = await run(MISMATCH, asin);

    expect(lookupChapterSeconds).not.toHaveBeenCalled();
    expect(result).toEqual({ verdict: MISMATCH });
  });

  it('a qualifying mismatch issues exactly ONE lookup and promotes on a usable in-band runtime', async () => {
    const result = await run(MISMATCH, ASIN);

    expect(lookupChapterSeconds).toHaveBeenCalledExactlyOnceWith(ASIN);
    expect(result.verdict).toEqual(HIGH);
    expect(result.chapterSeconds).toBe(33219.49);
  });

  it('trims the ASIN before looking it up', async () => {
    await run(MISMATCH, `  ${ASIN}  `);

    expect(lookupChapterSeconds).toHaveBeenCalledWith(ASIN);
  });

  it('suppress-only: an OUT-OF-BAND chapter runtime leaves the mismatch standing', async () => {
    const result = await run(MISMATCH, ASIN, () => MISMATCH);

    expect(result.verdict).toEqual(MISMATCH);
  });

  it('no usable chapter runtime → the scalar verdict stands and the recheck never runs', async () => {
    lookupChapterSeconds.mockResolvedValue(undefined);
    const recheck = vi.fn(() => HIGH);

    const result = await run(MISMATCH, ASIN, recheck);

    expect(recheck).not.toHaveBeenCalled();
    expect(result).toEqual({ verdict: MISMATCH });
  });

  it('AC9 — a rejecting lookup never escapes: it degrades to the scalar verdict and logs at debug', async () => {
    lookupChapterSeconds.mockRejectedValue(new Error('chapters blew up'));

    const result = await run(MISMATCH, ASIN);

    expect(result).toEqual({ verdict: MISMATCH });
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ asin: ASIN }),
      expect.stringContaining('keeping the scalar duration verdict'),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
