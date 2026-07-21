import { describe, it, expect } from 'vitest';
import {
  isCleanImport,
  importSkipSummary,
  buildOutcomeToast,
  acceptedItemPaths,
  confirmErrorMessage,
} from './import-outcome.js';
import { ApiError } from '@/lib/api';
import type { SubmissionAggregates, StagedItemResultDto } from '@/lib/api';

const agg = (over: Partial<SubmissionAggregates> = {}): SubmissionAggregates => ({ accepted: 0, held: 0, skipped: 0, failed: 0, ...over });

describe('isCleanImport (count-driven, #1902)', () => {
  it('is clean only when held/skipped/failed are all zero', () => {
    expect(isCleanImport(agg({ accepted: 3 }))).toBe(true);
    expect(isCleanImport(agg({ held: 1 }))).toBe(false);
    expect(isCleanImport(agg({ skipped: 1 }))).toBe(false);
    expect(isCleanImport(agg({ failed: 1 }))).toBe(false);
  });
});

describe('importSkipSummary (#1822)', () => {
  it('names the incumbent title for a single skip that carries one', () => {
    expect(importSkipSummary([{ reason: 'already-in-library', existingTitle: 'Fablehaven' }]))
      .toBe("already in your library as 'Fablehaven'");
  });

  it('uses the count form for multiple owned skips or a single owned skip without a title', () => {
    expect(importSkipSummary([{ reason: 'already-in-library' }])).toBe('1 already in your library');
    expect(importSkipSummary([{ reason: 'already-in-library' }, { reason: 'already-in-library' }])).toBe('2 already in your library');
  });

  it('names already-importing skips distinctly from already-in-library (#1822 F1)', () => {
    expect(importSkipSummary([{ reason: 'already-importing' }])).toBe('1 already being imported');
    expect(importSkipSummary([{ reason: 'already-importing' }, { reason: 'already-importing' }])).toBe('2 already being imported');
  });

  it('joins mixed-reason batches into per-reason sub-phrases (#1822 F1)', () => {
    expect(importSkipSummary([{ reason: 'already-in-library' }, { reason: 'already-importing' }]))
      .toBe('1 already in your library · 1 already being imported');
  });
});

describe('buildOutcomeToast (count-driven, #1902)', () => {
  it('green only on a fully-clean, accepted-bearing outcome', () => {
    expect(buildOutcomeToast(agg({ accepted: 2 }), 'queued for import'))
      .toEqual({ severity: 'success', message: '2 books queued for import' });
    expect(buildOutcomeToast(agg({ accepted: 1 }), 'registered'))
      .toEqual({ severity: 'success', message: '1 book registered' });
  });

  it('stays silent for a held-only or held+accepted batch (held has its own surface)', () => {
    expect(buildOutcomeToast(agg({ held: 1 }), 'registered')).toBeNull();
    expect(buildOutcomeToast(agg({ accepted: 1, held: 1 }), 'registered')).toBeNull();
  });

  it('amber for skipped (no green), red for any failure', () => {
    expect(buildOutcomeToast(agg({ skipped: 1 }), 'registered'))
      .toEqual({ severity: 'warning', message: '1 skipped' });
    expect(buildOutcomeToast(agg({ accepted: 1, failed: 1 }), 'queued for import'))
      .toEqual({ severity: 'error', message: '1 queued for import · 1 failed' });
  });

  it('post-prune counts still drive severity — never a false green (#1902 F29)', () => {
    // A pruned record keeps only counts; a skipped/failed count still reads truthfully.
    expect(buildOutcomeToast(agg({ accepted: 5, skipped: 2 }), 'registered'))
      .toEqual({ severity: 'warning', message: '5 registered · 2 skipped' });
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

describe('acceptedItemPaths (count-driven detail projection, #1902)', () => {
  it('collects the paths of rows whose disposition is accepted', () => {
    const items: StagedItemResultDto[] = [
      { disposition: 'accepted', ordinal: 0, path: '/a', title: 'A', bookId: 1 },
      { disposition: 'held', ordinal: 1, path: '/b', title: 'B', reason: 'recording-review-required' },
      { disposition: 'skipped', ordinal: 2, path: '/c', title: 'C', reason: 'already-in-library' },
      { disposition: 'accepted', ordinal: 3, path: '/d', title: 'D', bookId: 2 },
    ];
    expect([...acceptedItemPaths(items)].sort()).toEqual(['/a', '/d']);
  });
});
