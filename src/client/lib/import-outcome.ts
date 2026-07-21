import { ApiError } from '@/lib/api';
import type { SubmissionAggregates, StagedItemResultDto } from '@/lib/api';
import type { ImportSkipReason } from '../../shared/schemas/library-scan.js';
import { getErrorMessage } from '@/lib/error-message.js';

/**
 * Count-driven import outcome helpers (#1822 → #1902). The staged submission's durable
 * header always carries aggregate counts (`accepted`/`held`/`skipped`/`failed`), so
 * severity/message decisions are made from COUNTS — identical pre-prune, truthful
 * post-prune, never a false green. `importSkipSummary` and `acceptedItemPaths` operate
 * over the per-row detail projection (retained columns survive `itemPayload` nulling).
 */

export interface OutcomeToast {
  severity: 'success' | 'warning' | 'error';
  message: string;
}

/** A fully-clean outcome: nothing held/skipped/failed (accepted may be any count). */
export function isCleanImport(agg: SubmissionAggregates): boolean {
  return agg.held === 0 && agg.skipped === 0 && agg.failed === 0;
}

/** The subset of a skipped detail row this summary reads. */
export interface SkipSummaryRow {
  reason: ImportSkipReason;
  existingTitle?: string;
}

/**
 * Human phrase for the skipped rows, grouped by `reason` (#1822) so an
 * `already-importing` conflict is named as such instead of being mislabelled as
 * already-in-library. Names the incumbent title when a single owned item carries one.
 * Mixed-reason batches join their sub-phrases.
 */
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

/**
 * Build the consolidated accepted/skipped/failed toast purely from aggregate counts.
 * Held rows are surfaced separately (their recovery panel + warning), so a held-only
 * batch returns `null` here (this channel stays silent). `acceptedVerb` is the page's
 * word for an accepted item ("queued for import", "registered").
 */
export function buildOutcomeToast(agg: SubmissionAggregates, acceptedVerb: string): OutcomeToast | null {
  const { accepted, skipped, failed } = agg;

  // Fully clean → green (nothing held/skipped/failed).
  if (isCleanImport(agg)) {
    return accepted > 0 ? { severity: 'success', message: `${accepted} book${accepted !== 1 ? 's' : ''} ${acceptedVerb}` } : null;
  }

  // Not clean, but only held items differ: the held items are surfaced by their own
  // warning + recovery panel, so this channel stays silent rather than colouring amber.
  if (skipped === 0 && failed === 0) return null;

  const parts: string[] = [];
  if (accepted > 0) parts.push(`${accepted} ${acceptedVerb}`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);

  return { severity: failed > 0 ? 'error' : 'warning', message: parts.join(' · ') };
}

/**
 * Paths of the rows the server accepted, read from the terminal detail projection
 * (#1902). Each DTO row carries a non-null projected `path` even after `itemPayload`
 * nulling, so a recovered detail can still identify accepted rows for deselection.
 */
export function acceptedItemPaths(items: readonly StagedItemResultDto[]): Set<string> {
  return new Set(items.filter(i => i.disposition === 'accepted').map(i => i.path));
}

/**
 * Import-domain wording for a transport failure (#1831). A 413 (from either the
 * Fastify body limit or, more commonly, the nginx proxy hop that bypasses our error
 * handler entirely) is mapped to an actionable message telling the user the request was
 * too large — the raw "Payload Too Large" / generic message reads as a mystery failure.
 */
export function confirmErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 413) {
    return 'The import request was too large to send. Select fewer books and try again.';
  }
  return getErrorMessage(error);
}
