import { describe, it, expect } from 'vitest';
import {
  isCleanImport,
  importSkipSummary,
  buildOutcomeToast,
  acceptedItemPaths,
  buildChunkedOutcomeToast,
  isChunkedCleanImport,
  confirmErrorMessage,
} from './import-outcome.js';
import { ApiError } from '@/lib/api';
import type { ImportResult } from '@/lib/api';
import type { ChunkedConfirmResult } from './confirm-chunk-runner.js';

const base: ImportResult = { accepted: 0, heldReview: [], skipped: [], failed: [] };

/** A fully-submitted chunked run wrapping an aggregate ImportResult. */
function submittedRun(aggregate: ImportResult): ChunkedConfirmResult {
  return {
    aggregateResult: aggregate,
    submittedItems: [],
    unsubmitted: { count: 0, inFlight: 0, remainder: 0, reason: null, reasonKind: null },
    tooLarge: { count: 0 },
  };
}

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

describe('isChunkedCleanImport (#1831)', () => {
  it('is clean only when the aggregate is clean AND nothing is unsubmitted or too-large', () => {
    expect(isChunkedCleanImport(submittedRun({ ...base, accepted: 3 }))).toBe(true);
    const withUnsubmitted: ChunkedConfirmResult = { ...submittedRun({ ...base, accepted: 3 }), unsubmitted: { count: 2, inFlight: 1, remainder: 1, reason: 'x', reasonKind: 'transport' } };
    expect(isChunkedCleanImport(withUnsubmitted)).toBe(false);
    const withTooLarge: ChunkedConfirmResult = { ...submittedRun({ ...base, accepted: 3 }), tooLarge: { count: 1 } };
    expect(isChunkedCleanImport(withTooLarge)).toBe(false);
  });
});

describe('buildChunkedOutcomeToast (#1831)', () => {
  it('defers to buildOutcomeToast when everything packed was submitted', () => {
    expect(buildChunkedOutcomeToast(submittedRun({ ...base, accepted: 2 }), 'registered'))
      .toEqual({ severity: 'success', message: '2 books registered' });
  });

  it('mid-sequence failure: red toast naming accepted, the in-flight chunk, and the remainder', () => {
    const res: ChunkedConfirmResult = {
      aggregateResult: { ...base, accepted: 4 },
      submittedItems: [],
      unsubmitted: { count: 3, inFlight: 1, remainder: 2, reason: 'connection reset', reasonKind: 'transport' },
      tooLarge: { count: 0 },
    };
    expect(buildChunkedOutcomeToast(res, 'registered')).toEqual({
      severity: 'error',
      message: '4 registered · 1 not confirmed — connection failed mid-request; resubmitting is safe · 2 not submitted',
    });
  });

  it('mid-sequence 413: red toast names the too-large cause and drops the resubmit-safe claim (#1833)', () => {
    const res: ChunkedConfirmResult = {
      aggregateResult: { ...base, accepted: 4 },
      submittedItems: [],
      unsubmitted: { count: 3, inFlight: 1, remainder: 2, reason: 'Payload Too Large', reasonKind: 'too-large' },
      tooLarge: { count: 0 },
    };
    const toast = buildChunkedOutcomeToast(res, 'registered')!;
    expect(toast.severity).toBe('error');
    expect(toast.message).toContain('the import request was too large');
    expect(toast.message).not.toContain('resubmitting is safe');
  });

  it('too-large only: amber toast naming the too-large rows, no green', () => {
    const res: ChunkedConfirmResult = { ...submittedRun({ ...base, accepted: 2 }), tooLarge: { count: 1 } };
    expect(buildChunkedOutcomeToast(res, 'registered')).toEqual({
      severity: 'warning',
      message: '2 registered · 1 too large to submit — remove or re-scan',
    });
  });
});

describe('confirmErrorMessage (#1831)', () => {
  it('maps a 413 ApiError to actionable import-domain wording', () => {
    const err = new ApiError(413, { error: 'Payload Too Large' });
    expect(confirmErrorMessage(err)).toBe('The import request was too large to send. Select fewer books and try again.');
  });

  it('passes through a non-413 error message unchanged', () => {
    expect(confirmErrorMessage(new ApiError(500, { error: 'boom' }))).toBe('boom');
    expect(confirmErrorMessage(new Error('network failure'))).toBe('network failure');
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
