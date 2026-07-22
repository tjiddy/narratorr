import { describe, it, expect } from 'vitest';
import type { SubmissionAggregates } from '@/lib/api';
import { isCleanCompletion, isServerAggregateClean, buildStagedOutcomeToast, NO_LOCAL_EXCLUSIONS } from './outcome.js';

const agg = (o: Partial<SubmissionAggregates> = {}): SubmissionAggregates => ({ accepted: 0, held: 0, skipped: 0, failed: 0, ...o });

describe('isServerAggregateClean / isCleanCompletion (F4/F29)', () => {
  it('is clean when nothing held/skipped/failed and no local exclusions', () => {
    expect(isServerAggregateClean(agg({ accepted: 3 }))).toBe(true);
    expect(isCleanCompletion(agg({ accepted: 3 }), NO_LOCAL_EXCLUSIONS)).toBe(true);
  });
  it('a server-clean completion with local exclusions is NOT clean (blocks green/navigation)', () => {
    expect(isCleanCompletion(agg({ accepted: 3 }), { invalid: 1, oversize: 0 })).toBe(false);
    expect(isCleanCompletion(agg({ accepted: 3 }), { invalid: 0, oversize: 2 })).toBe(false);
  });
  it('any server held/skipped/failed is not clean', () => {
    expect(isCleanCompletion(agg({ accepted: 2, held: 1 }), NO_LOCAL_EXCLUSIONS)).toBe(false);
    expect(isCleanCompletion(agg({ accepted: 2, skipped: 1 }), NO_LOCAL_EXCLUSIONS)).toBe(false);
    expect(isCleanCompletion(agg({ accepted: 2, failed: 1 }), NO_LOCAL_EXCLUSIONS)).toBe(false);
  });
  it('a completion recovered on remount is count-only (default no-local ⇒ clean by counts alone)', () => {
    expect(isCleanCompletion(agg({ accepted: 5 }))).toBe(true);
  });
});

describe('buildStagedOutcomeToast (F29 — count-driven)', () => {
  it('green on a fully clean completion', () => {
    expect(buildStagedOutcomeToast(agg({ accepted: 3 }), NO_LOCAL_EXCLUSIONS, 'registered')).toEqual({
      severity: 'success',
      message: '3 books registered',
    });
  });
  it('null when there is nothing to accept and everything is clean', () => {
    expect(buildStagedOutcomeToast(agg(), NO_LOCAL_EXCLUSIONS, 'registered')).toBeNull();
  });
  it('null for a held-only outcome with no local exclusions (held warning owns it)', () => {
    expect(buildStagedOutcomeToast(agg({ accepted: 2, held: 1 }), NO_LOCAL_EXCLUSIONS, 'registered')).toBeNull();
  });
  it('warning for a skipped batch', () => {
    expect(buildStagedOutcomeToast(agg({ accepted: 2, skipped: 1 }), NO_LOCAL_EXCLUSIONS, 'registered')).toEqual({
      severity: 'warning',
      message: '2 registered · 1 skipped',
    });
  });
  it('error when anything failed', () => {
    expect(buildStagedOutcomeToast(agg({ accepted: 1, failed: 2 }), NO_LOCAL_EXCLUSIONS, 'registered')).toEqual({
      severity: 'error',
      message: '1 registered · 2 failed',
    });
  });
  it('local exclusions block green and add actionable clauses', () => {
    expect(buildStagedOutcomeToast(agg({ accepted: 4 }), { invalid: 2, oversize: 1 }, 'registered')).toEqual({
      severity: 'warning',
      message: '4 registered · 2 couldn’t be prepared — check their details · 1 too large to submit — remove or re-scan',
    });
  });
});
