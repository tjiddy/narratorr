import { ApiError } from '@/lib/api';
import type { SubmissionAggregates, StagedItemResultDto } from '@/lib/api';
import type { ImportSkipReason } from '@shared/schemas/library-scan.js';
import { getErrorMessage } from '@/lib/error-message.js';

/**
 * Outcome severity uses durable aggregate counts; row helpers use projections that survive
 * payload pruning. Toast composition belongs in `staged-import/outcome.ts`.
 */

export interface OutcomeToast {
  severity: 'success' | 'warning' | 'error';
  message: string;
}

export function isCleanImport(agg: SubmissionAggregates): boolean {
  return agg.held === 0 && agg.skipped === 0 && agg.failed === 0;
}

export interface SkipSummaryRow {
  reason: ImportSkipReason;
  existingTitle?: string;
}

export function importSkipSummary(skipped: readonly SkipSummaryRow[]): string {
  const owned = skipped.filter(s => s.reason === 'already-in-library');
  const importing = skipped.filter(s => s.reason === 'already-importing');

  const parts: string[] = [];
  if (owned.length === 1 && owned[0]!.existingTitle) {
    parts.push(`already in your library as '${owned[0]!.existingTitle}'`);
  } else if (owned.length > 0) {
    parts.push(`${owned.length} already in your library`);
  }
  if (importing.length > 0) {
    parts.push(`${importing.length} already being imported`);
  }
  return parts.join(' · ');
}

/** Projected paths remain available after item payloads are pruned. */
export function acceptedItemPaths(items: readonly StagedItemResultDto[]): Set<string> {
  return new Set(items.filter(i => i.disposition === 'accepted').map(i => i.path));
}

/** Rewords proxy or server 413 responses as an actionable import error. */
export function confirmErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 413) {
    return 'The import request was too large to send. Select fewer books and try again.';
  }
  return getErrorMessage(error);
}
