import { searchDropReasonSchema, type SearchDropReason, type SearchDropSummary } from '@shared/schemas/search-stream.js';
import type { SearchFilterOptions } from './search-pipeline.js';

export type SearchDropCounts = Partial<Record<SearchDropReason, number>>;

/**
 * A reason carries a threshold only when the setting behind it is in its enabled state; a disabled
 * setting omits the key rather than rendering "0 MB". `minDownloadSize` is MB and `maxDownloadSize`
 * is GB — the units `buildQualityGates` multiplies by, not a shared one.
 */
const THRESHOLDS: Record<SearchDropReason, (o: SearchFilterOptions) => string | undefined> = {
  'blacklist-match': () => undefined,
  'reject-word-match': () => undefined,
  'required-word-missing': () => undefined,
  'ebook-only-format': () => undefined,
  'below-min-seeders': (o) => (o.minSeeders > 0 ? `${o.minSeeders} seeders` : undefined),
  'below-grab-floor': (o) => (o.grabFloor > 0 ? `${o.grabFloor} MB/hour` : undefined),
  'below-min-size': (o) => (o.minDownloadSize ? `${o.minDownloadSize} MB` : undefined),
  'over-max-size': (o) => (o.maxDownloadSize ? `${o.maxDownloadSize} GB` : undefined),
  'language-mismatch': (o) => (o.languages?.length ? o.languages.join(', ') : undefined),
};

/** Pure: no I/O, no settings of its own. Ties break on the vocabulary order, so output is stable. */
export function summarizeDrops(counts: SearchDropCounts, options: SearchFilterOptions): SearchDropSummary {
  const reasons = searchDropReasonSchema.options
    .map((reason, order) => ({ reason, count: counts[reason] ?? 0, order }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ reason, count }) => {
      const threshold = THRESHOLDS[reason](options);
      return { reason, count, ...(threshold !== undefined && { threshold }) };
    });

  return { total: reasons.reduce((sum, entry) => sum + entry.count, 0), reasons };
}

/** The blacklist gate runs ahead of the quality gates, so its count merges into the built summary. */
export function withBlacklistDrops(
  summary: SearchDropSummary,
  blacklistedCount: number,
  options: SearchFilterOptions,
): SearchDropSummary {
  if (blacklistedCount <= 0) return summary;
  const counts: SearchDropCounts = { 'blacklist-match': blacklistedCount };
  for (const entry of summary.reasons) counts[entry.reason] = entry.count;
  return summarizeDrops(counts, options);
}

/** Parallels 'All search results removed by quality filters' so one grep family covers both signals. */
export const BLACKLIST_EMPTIED_MESSAGE = 'All search results removed by the blacklist';

/**
 * Log fields for a set the blacklist gate emptied, for the three paths that return before the quality
 * gates ever see it. Delegates to describeEmptiedSet so the key set cannot drift from that line.
 */
export function describeBlacklistEmptiedSet(inputCount: number, blacklistedCount: number): Record<string, unknown> {
  const summary: SearchDropSummary = { total: blacklistedCount, reasons: [{ reason: 'blacklist-match', count: blacklistedCount }] };
  return describeEmptiedSet(summary, inputCount);
}

/** Log fields for a result set the filters emptied; the threshold key follows the AC4 rule. */
export function describeEmptiedSet(summary: SearchDropSummary, inputCount: number): Record<string, unknown> {
  const dominant = summary.reasons[0];
  return {
    inputCount,
    droppedCount: summary.total,
    ...(dominant && { reason: dominant.reason }),
    ...(dominant?.threshold !== undefined && { threshold: dominant.threshold }),
    dropCounts: Object.fromEntries(summary.reasons.map((entry) => [entry.reason, entry.count])),
  };
}
