import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { applyChapterRuntimeRescue, type ChapterRuntimeSource } from './match-job-duration-rescue.js';
import type { MatchResult } from './match-job.types.js';
import type { NarratorCapContext } from './match-job.helpers.js';
import type { MatchReasonKind } from '../../shared/match-reason-kind.js';
import type { BookMetadata } from '../../core/metadata/index.js';

// Exact Fablehaven numbers from the UAT report (#1934): scanned 33219.47s, scalar
// 539min (32340s), usable chapter runtime 33219490ms.
const SCANNED_SECONDS = 33219.47;
const CHAPTER_MS = 33219490;

function makeMeta(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Fablehaven, Book 1',
    authors: [{ name: 'Brandon Mull' }],
    asin: 'B00CXXEX8W',
    duration: 539, // scalar minutes → 32340s, out of band vs the scan
    ...overrides,
  };
}

function makeMismatchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    path: '/audiobooks/Fablehaven',
    confidence: 'medium',
    bestMatch: makeMeta(),
    alternatives: [],
    reason: 'Duration mismatch — scanned 9h 13m vs expected 8h 59m',
    reasonKind: 'duration-mismatch',
    ...overrides,
  };
}

function makeCapCtx(overrides: Partial<NarratorCapContext> = {}): NarratorCapContext {
  return { log: inject<FastifyBaseLogger>(createMockLogger()), matchSource: 'filename-duration-resolved', durationVerified: false, ...overrides };
}

function makeSource(runtimeMs: number | null): ChapterRuntimeSource & { getChapterRuntimeMs: ReturnType<typeof vi.fn> } {
  return { getChapterRuntimeMs: vi.fn().mockResolvedValue(runtimeMs) };
}

describe('applyChapterRuntimeRescue (#1934)', () => {
  let rawLog: ReturnType<typeof createMockLogger>;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    rawLog = createMockLogger();
    log = inject<FastifyBaseLogger>(rawLog);
  });

  describe('AC1 — corroborated rescue', () => {
    it('promotes a scalar duration-mismatch to high when a usable chapter runtime is in band', async () => {
      const chapters = makeSource(CHAPTER_MS);
      const capCtx = makeCapCtx();
      const { resolved, capCtx: outCtx } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(),
        capCtx,
        scannedSeconds: SCANNED_SECONDS,
        chapters,
        log,
      });

      expect(chapters.getChapterRuntimeMs).toHaveBeenCalledExactlyOnceWith('B00CXXEX8W');
      expect(resolved.confidence).toBe('high');
      expect(resolved.reason).toBeUndefined();
      expect(resolved.reasonKind).toBeUndefined();
      expect(outCtx.durationVerified).toBe(true);
    });

    it('preserves bestMatch, alternatives, and path on promotion (only confidence/reason change)', async () => {
      const alt = makeMeta({ asin: 'B0OTHER' });
      const chapters = makeSource(CHAPTER_MS);
      const { resolved } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult({ alternatives: [alt] }),
        capCtx: makeCapCtx(),
        scannedSeconds: SCANNED_SECONDS,
        chapters,
        log,
      });

      expect(resolved.path).toBe('/audiobooks/Fablehaven');
      expect(resolved.bestMatch?.asin).toBe('B00CXXEX8W');
      expect(resolved.alternatives).toEqual([alt]);
    });

    it('leaves the other capCtx fields intact on promotion', async () => {
      const chapters = makeSource(CHAPTER_MS);
      const capCtx = makeCapCtx({ matchSource: 'asin-tag' });
      const { capCtx: outCtx } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(),
        capCtx,
        scannedSeconds: SCANNED_SECONDS,
        chapters,
        log,
      });
      expect(outCtx.matchSource).toBe('asin-tag');
      expect(outCtx.durationVerified).toBe(true);
      expect(outCtx.log).toBe(capCtx.log);
    });
  });

  describe('AC4 — laziness: no fetch unless the verdict is a duration-mismatch with an ASIN', () => {
    it.each<[string, MatchReasonKind | undefined]>([
      ['scalar-verified high (no reasonKind)', undefined],
      ['missing-duration', 'missing-duration'],
      ['no-duration-data', 'no-duration-data'],
    ])('does not fetch chapters for %s', async (_label, reasonKind) => {
      const chapters = makeSource(CHAPTER_MS);
      // Non-mismatch verdicts: a scalar-verified high carries no reason/reasonKind;
      // the two incomplete-evidence mediums carry their own reasonKind (not 'duration-mismatch').
      const resolved: MatchResult = reasonKind === undefined
        ? { path: '/audiobooks/Fablehaven', confidence: 'high', bestMatch: makeMeta(), alternatives: [] }
        : { path: '/audiobooks/Fablehaven', confidence: 'medium', bestMatch: makeMeta(), alternatives: [], reason: 'cannot verify', reasonKind };
      const out = await applyChapterRuntimeRescue({ resolved, capCtx: makeCapCtx(), scannedSeconds: SCANNED_SECONDS, chapters, log });
      expect(chapters.getChapterRuntimeMs).not.toHaveBeenCalled();
      expect(out.resolved).toBe(resolved); // unchanged reference
    });

    it('does not fetch when the top candidate has no ASIN', async () => {
      const chapters = makeSource(CHAPTER_MS);
      const resolved = makeMismatchResult({ bestMatch: makeMeta({ asin: undefined }) });
      const out = await applyChapterRuntimeRescue({ resolved, capCtx: makeCapCtx(), scannedSeconds: SCANNED_SECONDS, chapters, log });
      expect(chapters.getChapterRuntimeMs).not.toHaveBeenCalled();
      expect(out.resolved.confidence).toBe('medium');
      expect(out.resolved.reasonKind).toBe('duration-mismatch');
    });

    it('does not fetch when there is no scanned runtime', async () => {
      const chapters = makeSource(CHAPTER_MS);
      const resolved = makeMismatchResult();
      const out = await applyChapterRuntimeRescue({ resolved, capCtx: makeCapCtx(), scannedSeconds: undefined, chapters, log });
      expect(chapters.getChapterRuntimeMs).not.toHaveBeenCalled();
      expect(out.resolved.confidence).toBe('medium');
    });
  });

  describe('AC2/AC7 — degradation preserves the scalar mismatch', () => {
    it('keeps the mismatch when there is no usable chapter runtime (null)', async () => {
      const chapters = makeSource(null);
      const capCtx = makeCapCtx();
      const { resolved, capCtx: outCtx } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(), capCtx, scannedSeconds: SCANNED_SECONDS, chapters, log,
      });
      expect(resolved.confidence).toBe('medium');
      expect(resolved.reasonKind).toBe('duration-mismatch');
      expect(resolved.reason).toContain('Duration mismatch');
      expect(outCtx.durationVerified).toBe(false);
      expect(rawLog.debug).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B00CXXEX8W' }), expect.stringContaining('No usable chapter runtime'));
    });

    it('keeps the mismatch when the usable chapter runtime is out of band (defective file)', async () => {
      // Scanned 30000s matches neither the scalar (32340s) nor the chapters
      // (33219.49s) — a defective file must still flag (cardinal-sin protection).
      const chapters = makeSource(CHAPTER_MS);
      const { resolved } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(), capCtx: makeCapCtx(), scannedSeconds: 30000, chapters, log,
      });
      expect(resolved.confidence).toBe('medium');
      expect(resolved.reasonKind).toBe('duration-mismatch');
      expect(rawLog.debug).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B00CXXEX8W' }), expect.stringContaining('out of band'));
    });

    it('degrades to the scalar verdict and logs debug when the lookup throws (never propagates)', async () => {
      const chapters: ChapterRuntimeSource = { getChapterRuntimeMs: vi.fn().mockRejectedValue(new Error('boom')) };
      const { resolved, capCtx: outCtx } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(), capCtx: makeCapCtx(), scannedSeconds: SCANNED_SECONDS, chapters, log,
      });
      expect(resolved.confidence).toBe('medium');
      expect(resolved.reasonKind).toBe('duration-mismatch');
      expect(outCtx.durationVerified).toBe(false);
      expect(rawLog.debug).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B00CXXEX8W' }), expect.stringContaining('threw'));
    });
  });

  describe('AC5/AC8 — inclusive 240s boundary, reusing withinDurationTolerance', () => {
    it('rescues when the chapter runtime is exactly 240s from the scan (inclusive)', async () => {
      // scanned 1000s; chapters 1240s → Δ240s → in band.
      const chapters = makeSource(1240 * 1000);
      const { resolved } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(), capCtx: makeCapCtx(), scannedSeconds: 1000, chapters, log,
      });
      expect(resolved.confidence).toBe('high');
    });

    it('does NOT rescue when the chapter runtime is 241s from the scan (exclusive)', async () => {
      const chapters = makeSource(1241 * 1000);
      const { resolved } = await applyChapterRuntimeRescue({
        resolved: makeMismatchResult(), capCtx: makeCapCtx(), scannedSeconds: 1000, chapters, log,
      });
      expect(resolved.confidence).toBe('medium');
      expect(resolved.reasonKind).toBe('duration-mismatch');
    });
  });
});
