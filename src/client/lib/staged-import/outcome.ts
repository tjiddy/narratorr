import type { SubmissionAggregates } from '@/lib/api';
import { isCleanImport, importSkipSummary, type OutcomeToast, type SkipSummaryRow } from '@/lib/import-outcome.js';

/**
 * Count-driven outcome projection for the staged flow (#1902, F4/F7/F8/F29).
 *
 * The durable header always carries aggregate counts (`accepted`/`held`/`skipped`/
 * `failed`); `detailsPruned` signals the per-row detail is gone. Severity and the
 * toast are decided from COUNTS — identical pre-prune, truthful post-prune, never a
 * false green. Separately, locally-excluded rows (invalid + oversize) never enter
 * server counts, so the in-session `{invalid, oversize}` summary is composed in here:
 * ANY local exclusion blocks the green toast + `/library` navigation. A completion
 * recovered on remount has NO local summary (it never survives a reload) and is
 * therefore count-only.
 */

export interface LocalExclusions {
  invalid: number;
  oversize: number;
}

export const NO_LOCAL_EXCLUSIONS: LocalExclusions = { invalid: 0, oversize: 0 };

/**
 * The server aggregate is clean when nothing was held/skipped/failed. This is the ONE
 * canonical clean predicate — it delegates to `isCleanImport` in `import-outcome.ts`
 * rather than re-implementing the same count check, so severity/navigation decisions
 * can never drift between the two modules (#1902 F11 / DRY-2/DRY-3).
 */
export const isServerAggregateClean = isCleanImport;

/** A completion is clean only when the server aggregate is clean AND no in-session rows were excluded. */
export function isCleanCompletion(agg: SubmissionAggregates, local: LocalExclusions = NO_LOCAL_EXCLUSIONS): boolean {
  return isServerAggregateClean(agg) && local.invalid === 0 && local.oversize === 0;
}

/**
 * Build the consolidated accepted/skipped/failed + local-exclusion toast (F29). Severity
 * is count-driven, but the SKIP clause names the reason/incumbent-title from the retained
 * per-row detail when it survived (`skippedRows` present) via `importSkipSummary`, falling
 * back to the count-only `"N skipped"` wording only after pruning drops the detail (F9).
 * Held rows are surfaced by their own warning/recovery panel, so a held-only outcome with
 * no local exclusions returns `null` here (this channel stays silent). ANY local exclusion
 * forces a non-null, non-green toast.
 */
/** Reason/title-named skip clause while detail survives; count-only after prune (F9). */
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

  // Held-only, nothing skipped/failed, and no local exclusions → the held warning covers it.
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
