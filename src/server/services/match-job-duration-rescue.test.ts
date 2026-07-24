import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { DurationConfidenceResult } from './match-job.helpers.js';
import { applyChapterRuntimeRescue } from './match-job-duration-rescue.js';

const log = inject<FastifyBaseLogger>(createMockLogger());

function meta(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return { title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], asin: 'B00CXXEX8W', duration: 539, ...overrides };
}

const MISMATCH: DurationConfidenceResult = {
  confidence: 'medium',
  reason: 'Duration mismatch — scanned 9h 13m vs expected 8h 59m',
  reasonKind: 'duration-mismatch',
};

/** getChapterRuntimeMs stub returning a fixed value; exposes the spy for call-count. */
function chapterStub(runtimeMs: number | null) {
  const getChapterRuntimeMs = vi.fn().mockResolvedValue(runtimeMs);
  return { deps: { getChapterRuntimeMs, log }, spy: getChapterRuntimeMs };
}

describe('applyChapterRuntimeRescue (#1932)', () => {
  // Fablehaven fix: scanned 33219.47s, scalar 539min (32340s, Δ879 out), chapter
  // 33219490ms (33219.49s, Δ≈0.02 in) → rescued to high, duration reason cleared.
  it('scalar fails + usable chapter within band → high, no reason, no reasonKind', async () => {
    const { deps, spy } = chapterStub(33219490);
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta(), scannedSeconds: 33219.47, scalarVerified: false,
    });
    expect(out.verdict).toEqual({ confidence: 'high' });
    expect(out.verdict.reason).toBeUndefined();
    expect(out.verdict.reasonKind).toBeUndefined();
    expect(out.durationVerified).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('B00CXXEX8W');
  });

  it('scalar fails + usable chapter OUTSIDE band → medium / duration-mismatch preserved', async () => {
    // Truncated file: scanned ~30000s, chapter 33219490ms (33219.49s) → Δ~3219 out.
    const { deps } = chapterStub(33219490);
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta(), scannedSeconds: 30000, scalarVerified: false,
    });
    expect(out.verdict).toBe(MISMATCH);
    expect(out.verdict.reasonKind).toBe('duration-mismatch');
    expect(out.durationVerified).toBe(false);
  });

  // Wrong-edition, scalar out + chapter out — the common true-positive case.
  it('wrong-edition, chapter also outside band → still flags medium / duration-mismatch', async () => {
    const { deps } = chapterStub(20000000); // 20000s — far from a 33219s scan
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta({ asin: 'B_WRONG' }), scannedSeconds: 33219.47, scalarVerified: false,
    });
    expect(out.verdict).toBe(MISMATCH);
    expect(out.durationVerified).toBe(false);
  });

  // Wrong-edition, scalar out + chapter IN — AC3 explicit bounded narrowing.
  it('wrong-edition whose chapter total lands in band → high (AC3 narrowing, pinned)', async () => {
    const { deps } = chapterStub(33219490);
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta({ asin: 'B_WRONG_EDITION' }), scannedSeconds: 33219.47, scalarVerified: false,
    });
    expect(out.verdict).toEqual({ confidence: 'high' });
    expect(out.durationVerified).toBe(true);
  });

  it('boundary: chapter runtime exactly 240s from scan → inside (inclusive) → rescued', async () => {
    const { deps } = chapterStub(33_000_000); // 33000s; scan 33240s → Δ exactly 240
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta(), scannedSeconds: 33240, scalarVerified: false,
    });
    expect(out.verdict).toEqual({ confidence: 'high' });
  });

  it('boundary: chapter runtime 241s from scan → outside → not rescued', async () => {
    const { deps } = chapterStub(33_000_000); // 33000s; scan 33241s → Δ 241
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta(), scannedSeconds: 33241, scalarVerified: false,
    });
    expect(out.verdict).toBe(MISMATCH);
  });

  it('units guard: 33219490 ms is compared as 33219.49 s, never 33219490 s', async () => {
    // If the ms value were compared raw against a ~33219s scan it would be wildly
    // out of band and never rescue; a correct /1000 rescues.
    const { deps } = chapterStub(33219490);
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta(), scannedSeconds: 33219.49, scalarVerified: false,
    });
    expect(out.verdict).toEqual({ confidence: 'high' });
  });

  it('no usable chapter runtime (null) → scalar verdict preserved, no rescue', async () => {
    const { deps, spy } = chapterStub(null);
    const out = await applyChapterRuntimeRescue(deps, {
      verdict: MISMATCH, bestMatch: meta(), scannedSeconds: 33219.47, scalarVerified: false,
    });
    expect(out.verdict).toBe(MISMATCH);
    expect(out.durationVerified).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1); // the miss is discovered BY the one call
  });

  describe('zero-call gating (F12/AC4)', () => {
    it('verdict is not a duration-mismatch (high) → no chapter call', async () => {
      const { deps, spy } = chapterStub(33219490);
      const out = await applyChapterRuntimeRescue(deps, {
        verdict: { confidence: 'high' }, bestMatch: meta(), scannedSeconds: 33219.47, scalarVerified: true,
      });
      expect(out.verdict).toEqual({ confidence: 'high' });
      expect(out.durationVerified).toBe(true); // scalarVerified passthrough
      expect(spy).not.toHaveBeenCalled();
    });

    it('no-signal verdict (missing-duration) → no chapter call, verdict unchanged', async () => {
      const missing: DurationConfidenceResult = { confidence: 'medium', reason: 'Best match missing duration — cannot verify', reasonKind: 'missing-duration' };
      const { deps, spy } = chapterStub(33219490);
      const out = await applyChapterRuntimeRescue(deps, {
        verdict: missing, bestMatch: meta(), scannedSeconds: 33219.47, scalarVerified: false,
      });
      expect(out.verdict).toBe(missing);
      expect(spy).not.toHaveBeenCalled();
    });

    it('no-signal verdict (no-duration-data) → no chapter call', async () => {
      const noData: DurationConfidenceResult = { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate', reasonKind: 'no-duration-data' };
      const { deps, spy } = chapterStub(33219490);
      const out = await applyChapterRuntimeRescue(deps, {
        verdict: noData, bestMatch: meta(), scannedSeconds: undefined, scalarVerified: false,
      });
      expect(out.verdict).toBe(noData);
      expect(spy).not.toHaveBeenCalled();
    });

    it('duration-mismatch but no ASIN → no chapter call, verdict preserved', async () => {
      const { deps, spy } = chapterStub(33219490);
      const out = await applyChapterRuntimeRescue(deps, {
        verdict: MISMATCH, bestMatch: meta({ asin: undefined }), scannedSeconds: 33219.47, scalarVerified: false,
      });
      expect(out.verdict).toBe(MISMATCH);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
