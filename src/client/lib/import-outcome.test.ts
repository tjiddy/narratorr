import { describe, it, expect } from 'vitest';
import { isCleanImport, importSkipSummary, buildOutcomeToast, acceptedItemPaths } from './import-outcome.js';
import type { ImportResult } from '@/lib/api';

const base: ImportResult = { accepted: 0, heldReview: [], skipped: [], failed: [] };

describe('isCleanImport (#1822)', () => {
  it('is clean only when held/skipped/failed are all empty', () => {
    expect(isCleanImport({ ...base, accepted: 3 })).toBe(true);
    expect(isCleanImport({ ...base, heldReview: [{ path: '/a', title: 'A', reason: 'recording-review-required' }] })).toBe(false);
    expect(isCleanImport({ ...base, skipped: [{ path: '/a', title: 'A', reason: 'already-in-library' }] })).toBe(false);
    expect(isCleanImport({ ...base, failed: [{ path: '/a', title: 'A', message: 'x' }] })).toBe(false);
  });
});

describe('importSkipSummary (#1822)', () => {
  it('names the incumbent title for a single skip that carries one', () => {
    expect(importSkipSummary([{ path: '/a', title: 'A', reason: 'already-in-library', existingTitle: 'Fablehaven' }]))
      .toBe("already in your library as 'Fablehaven'");
  });

  it('uses the count form for multiple owned skips or a single owned skip without a title', () => {
    expect(importSkipSummary([{ path: '/a', title: 'A', reason: 'already-in-library' }])).toBe('1 already in your library');
    expect(importSkipSummary([
      { path: '/a', title: 'A', reason: 'already-in-library' },
      { path: '/b', title: 'B', reason: 'already-in-library' },
    ])).toBe('2 already in your library');
  });

  it('names already-importing skips distinctly from already-in-library (#1822 F1)', () => {
    expect(importSkipSummary([{ path: '/a', title: 'A', reason: 'already-importing' }])).toBe('1 already being imported');
    expect(importSkipSummary([
      { path: '/a', title: 'A', reason: 'already-importing' },
      { path: '/b', title: 'B', reason: 'already-importing' },
    ])).toBe('2 already being imported');
  });

  it('joins mixed-reason batches into per-reason sub-phrases (#1822 F1)', () => {
    expect(importSkipSummary([
      { path: '/a', title: 'A', reason: 'already-in-library' },
      { path: '/b', title: 'B', reason: 'already-importing' },
    ])).toBe('1 already in your library · 1 already being imported');
  });
});

describe('buildOutcomeToast (#1822)', () => {
  it('green only on a fully-clean, accepted-bearing outcome', () => {
    expect(buildOutcomeToast({ ...base, accepted: 2 }, 'queued for import'))
      .toEqual({ severity: 'success', message: '2 books queued for import' });
    expect(buildOutcomeToast({ ...base, accepted: 1 }, 'registered'))
      .toEqual({ severity: 'success', message: '1 book registered' });
  });

  it('stays silent for a held-only or held+accepted batch (held has its own surface)', () => {
    expect(buildOutcomeToast({ ...base, heldReview: [{ path: '/a', title: 'A', reason: 'recording-review-required' }] }, 'registered')).toBeNull();
    expect(buildOutcomeToast({ ...base, accepted: 1, heldReview: [{ path: '/a', title: 'A', reason: 'recording-review-required' }] }, 'registered')).toBeNull();
  });

  it('amber for skipped (no green), red for any failure', () => {
    expect(buildOutcomeToast({ ...base, skipped: [{ path: '/a', title: 'A', reason: 'already-in-library' }] }, 'registered'))
      .toEqual({ severity: 'warning', message: '1 already in your library' });
    expect(buildOutcomeToast({ ...base, accepted: 1, failed: [{ path: '/a', title: 'A', message: 'x' }] }, 'queued for import'))
      .toEqual({ severity: 'error', message: '1 queued for import · 1 failed' });
  });
});

describe('acceptedItemPaths (#1822)', () => {
  it('derives accepted paths as submitted minus held/skipped/failed', () => {
    const submitted = [{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }, { path: '/c', title: 'C' }];
    const result: ImportResult = {
      accepted: 1,
      heldReview: [{ path: '/b', title: 'B', reason: 'recording-review-required' }],
      skipped: [{ path: '/c', title: 'C', reason: 'already-in-library' }],
      failed: [],
    };
    const accepted = acceptedItemPaths(submitted, result);
    expect([...accepted]).toEqual(['/a']);
  });
});
