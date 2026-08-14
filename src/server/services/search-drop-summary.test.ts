import { describe, it, expect } from 'vitest';
import { summarizeDrops, withBlacklistDrops, describeEmptiedSet, type SearchDropCounts } from './search-drop-summary.js';
import type { SearchFilterOptions } from './search-pipeline.js';

const baseOptions: SearchFilterOptions = {
  grabFloor: 0,
  minSeeders: 0,
  protocolPreference: 'none',
};

function options(overrides: Partial<SearchFilterOptions> = {}): SearchFilterOptions {
  return { ...baseOptions, ...overrides };
}

describe('summarizeDrops — ordering and totals', () => {
  // The dominant reason sits LAST in the vocabulary, so only the count sort can put it first.
  it('sorts reasons by count descending and totals the emitted counts', () => {
    const counts: SearchDropCounts = { 'reject-word-match': 3, 'language-mismatch': 5 };

    const summary = summarizeDrops(counts, options({ languages: ['english'] }));

    expect(summary.reasons.map((r) => r.reason)).toEqual(['language-mismatch', 'reject-word-match']);
    expect(summary.total).toBe(8);
  });

  it('breaks ties on the vocabulary order, not the input record order', () => {
    const seedersFirst = summarizeDrops({ 'below-min-seeders': 2, 'over-max-size': 2 }, options());
    const maxSizeFirst = summarizeDrops({ 'over-max-size': 2, 'below-min-seeders': 2 }, options());

    expect(seedersFirst.reasons.map((r) => r.reason)).toEqual(['below-min-seeders', 'over-max-size']);
    expect(maxSizeFirst.reasons.map((r) => r.reason)).toEqual(['below-min-seeders', 'over-max-size']);
  });

  it('omits zero-count entries and returns an empty summary for an all-zero record', () => {
    const summary = summarizeDrops({ 'below-min-size': 0, 'language-mismatch': 0 }, options({ minDownloadSize: 50 }));

    expect(summary).toEqual({ total: 0, reasons: [] });
  });

  it('totals exactly the sum of the emitted counts across three reasons', () => {
    const summary = summarizeDrops(
      { 'reject-word-match': 1, 'below-min-seeders': 4, 'language-mismatch': 2 },
      options({ minSeeders: 5, languages: ['english'] }),
    );

    expect(summary.reasons.map((r) => r.count)).toEqual([4, 2, 1]);
    expect(summary.total).toBe(7);
  });
});

describe('summarizeDrops — thresholds (AC4)', () => {
  it('renders the minimum size in MB and the maximum size in GB in the same summary', () => {
    const summary = summarizeDrops(
      { 'below-min-size': 1, 'over-max-size': 1 },
      options({ minDownloadSize: 50, maxDownloadSize: 20 }),
    );

    const byReason = Object.fromEntries(summary.reasons.map((r) => [r.reason, r.threshold]));
    expect(byReason['below-min-size']).toBe('50 MB');
    expect(byReason['over-max-size']).toBe('20 GB');
  });

  it('renders the seeders and grab-floor thresholds with their units', () => {
    const summary = summarizeDrops(
      { 'below-min-seeders': 1, 'below-grab-floor': 1 },
      options({ minSeeders: 5, grabFloor: 30 }),
    );

    const byReason = Object.fromEntries(summary.reasons.map((r) => [r.reason, r.threshold]));
    expect(byReason['below-min-seeders']).toBe('5 seeders');
    expect(byReason['below-grab-floor']).toBe('30 MB/hour');
  });

  it('comma-joins the allowed language list and emits a single language without a separator', () => {
    const pair = summarizeDrops({ 'language-mismatch': 1 }, options({ languages: ['English', 'German'] }));
    const single = summarizeDrops({ 'language-mismatch': 1 }, options({ languages: ['English'] }));

    expect(pair.reasons[0]!.threshold).toBe('English, German');
    expect(single.reasons[0]!.threshold).toBe('English');
  });

  it('omits the threshold key entirely for reasons with no settings-backed scalar', () => {
    const summary = summarizeDrops(
      { 'reject-word-match': 1, 'required-word-missing': 1, 'ebook-only-format': 1, 'blacklist-match': 1 },
      options({ minSeeders: 5, grabFloor: 30, minDownloadSize: 50, maxDownloadSize: 20, languages: ['english'] }),
    );

    expect(summary.reasons).toHaveLength(4);
    for (const entry of summary.reasons) {
      expect(entry).not.toHaveProperty('threshold');
    }
  });

  it.each([
    ['below-min-seeders', { minSeeders: 0 }],
    ['below-grab-floor', { grabFloor: 0 }],
    ['below-min-size', { minDownloadSize: 0 }],
    ['over-max-size', { maxDownloadSize: 0 }],
    ['language-mismatch', { languages: [] }],
  ] as const)('omits the threshold key for %s when its setting is disabled', (reason, disabled) => {
    const summary = summarizeDrops({ [reason]: 2 }, options(disabled));

    expect(summary.reasons).toHaveLength(1);
    expect(summary.reasons[0]!.count).toBe(2);
    expect(summary.reasons[0]).not.toHaveProperty('threshold');
  });

  it('omits the language threshold when no allowlist is configured at all', () => {
    const summary = summarizeDrops({ 'language-mismatch': 1 }, options());

    expect(summary.reasons[0]).not.toHaveProperty('threshold');
  });
});

describe('withBlacklistDrops', () => {
  it('merges the blacklist count into an existing summary and re-sorts', () => {
    const gates = summarizeDrops({ 'below-min-size': 1 }, options({ minDownloadSize: 50 }));

    const merged = withBlacklistDrops(gates, 2, options({ minDownloadSize: 50 }));

    expect(merged.total).toBe(3);
    expect(merged.reasons).toEqual([
      { reason: 'blacklist-match', count: 2 },
      { reason: 'below-min-size', count: 1, threshold: '50 MB' },
    ]);
  });

  it('returns the summary untouched when nothing was blacklisted', () => {
    const gates = summarizeDrops({ 'below-min-size': 1 }, options({ minDownloadSize: 50 }));

    expect(withBlacklistDrops(gates, 0, options({ minDownloadSize: 50 }))).toBe(gates);
  });
});

describe('describeEmptiedSet', () => {
  it('names the dominant reason, its threshold, and the per-reason counts', () => {
    const summary = summarizeDrops(
      { 'below-min-size': 3, 'below-min-seeders': 1 },
      options({ minDownloadSize: 50, minSeeders: 5 }),
    );

    expect(describeEmptiedSet(summary, 4)).toEqual({
      inputCount: 4,
      droppedCount: 4,
      reason: 'below-min-size',
      threshold: '50 MB',
      dropCounts: { 'below-min-size': 3, 'below-min-seeders': 1 },
    });
  });

  it('omits the threshold key when the dominant reason carries none', () => {
    const summary = summarizeDrops({ 'reject-word-match': 2 }, options());

    const fields = describeEmptiedSet(summary, 2);

    expect(fields).not.toHaveProperty('threshold');
    expect(fields).toEqual({
      inputCount: 2,
      droppedCount: 2,
      reason: 'reject-word-match',
      dropCounts: { 'reject-word-match': 2 },
    });
  });
});
