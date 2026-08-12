import type { SubmissionAggregates } from '@/lib/api';
import { isCleanImport, importSkipSummary, type OutcomeToast, type SkipSummaryRow } from '@/lib/import-outcome.js';

// Aggregate counts drive severity; in-session local exclusions also block clean outcomes.
// Recovered completions have no local exclusion summary and are therefore aggregate-only.

export interface LocalExclusions {
  invalid: number;
  oversize: number;
}

export const NO_LOCAL_EXCLUSIONS: LocalExclusions = { invalid: 0, oversize: 0 };

export const isServerAggregateClean = isCleanImport;

export function isCleanCompletion(agg: SubmissionAggregates, local: LocalExclusions = NO_LOCAL_EXCLUSIONS): boolean {
  return isServerAggregateClean(agg) && local.invalid === 0 && local.oversize === 0;
}

// Prefer detailed skip reasons; pruned results fall back to counts.
// Held-only outcomes stay silent because the held channel owns their warning.
function skipClause(skippedCount: number, skippedRows?: readonly SkipSummaryRow[]): string {
  return skippedRows && skippedRows.length > 0 ? importSkipSummary(skippedRows) : `${skippedCount} skipped`;
}

export function buildStagedOutcomeToast(
  agg: SubmissionAggregates,
  local: LocalExclusions,
  acceptedVerb: string,
  skippedRows?: readonly SkipSummaryRow[],
): OutcomeToast | null {
  const hasLocal = local.invalid > 0 || local.oversize > 0;

  if (isCleanCompletion(agg, local)) {
    return agg.accepted > 0 ? { severity: 'success', message: `${agg.accepted} book${agg.accepted !== 1 ? 's' : ''} ${acceptedVerb}` } : null;
  }

  if (agg.skipped === 0 && agg.failed === 0 && !hasLocal) return null;

  const parts: string[] = [];
  if (agg.accepted > 0) parts.push(`${agg.accepted} ${acceptedVerb}`);
  if (agg.skipped > 0) parts.push(skipClause(agg.skipped, skippedRows));
  if (agg.failed > 0) parts.push(`${agg.failed} failed`);
  if (local.invalid > 0) parts.push(`${local.invalid} couldn’t be prepared — check their details`);
  if (local.oversize > 0) parts.push(`${local.oversize} too large to submit — remove or re-scan`);

  const severity: OutcomeToast['severity'] = agg.failed > 0 ? 'error' : 'warning';
  return { severity, message: parts.join(' · ') };
}
