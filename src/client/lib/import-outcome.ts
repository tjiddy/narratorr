import { ApiError } from '@/lib/api';
import type { ImportResult, ImportConfirmItem } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import type { ChunkedConfirmResult } from './confirm-chunk-runner.js';

/**
 * Import-confirm outcome helpers (#1822). `confirmImport` returns four buckets —
 * `accepted` (a count), `heldReview`, `skipped`, `failed` — and the invariant
 * `accepted + heldReview + skipped + failed === items.length` holds. These helpers
 * turn that shape into the toast/severity/navigation decisions both import hooks
 * share, so a no-op import (all items skipped/failed) is never reported as a green
 * success and the accepted rows can be deselected when the user stays on the page.
 */

/** A fully-clean outcome: everything submitted was accepted (nothing held/skipped/failed). */
export function isCleanImport(result: ImportResult): boolean {
  return result.heldReview.length === 0 && result.skipped.length === 0 && result.failed.length === 0;
}

/**
 * Human phrase for the skipped bucket, grouped by `reason` (#1822) so an
 * `already-importing` conflict is named as such instead of being mislabelled as
 * already-in-library. Names the incumbent title when a single owned item carries one.
 * Mixed-reason batches join their sub-phrases (e.g. "1 already in your library · 1
 * already being imported").
 */
export function importSkipSummary(skipped: ImportResult['skipped']): string {
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

export interface OutcomeToast {
  severity: 'success' | 'warning' | 'error';
  message: string;
}

/**
 * Build the consolidated accepted/skipped/failed toast. Held items are surfaced
 * separately (their recovery panel + warning), so they are intentionally NOT part
 * of this channel — but their presence still blocks the green success (a clean
 * outcome requires the held bucket empty too). Returns `null` when this channel has
 * nothing to say (e.g. a held-only batch, where the held warning already covers it).
 * `acceptedVerb` is the page's word for an accepted item ("queued for import",
 * "registered").
 */
export function buildOutcomeToast(result: ImportResult, acceptedVerb: string): OutcomeToast | null {
  const { accepted, skipped, failed } = result;

  // Fully clean → green (nothing held/skipped/failed).
  if (isCleanImport(result)) {
    return accepted > 0 ? { severity: 'success', message: `${accepted} book${accepted !== 1 ? 's' : ''} ${acceptedVerb}` } : null;
  }

  // Not clean, but only held items differ (nothing skipped/failed): the accepted
  // items genuinely succeeded and the held items are surfaced by their own warning +
  // recovery panel, so this channel stays silent rather than colouring a success amber.
  if (skipped.length === 0 && failed.length === 0) return null;

  const parts: string[] = [];
  if (accepted > 0) parts.push(`${accepted} ${acceptedVerb}`);
  if (skipped.length > 0) parts.push(importSkipSummary(skipped));
  if (failed.length > 0) parts.push(`${failed.length} failed`);

  return { severity: failed.length > 0 ? 'error' : 'warning', message: parts.join(' · ') };
}

/**
 * The set of submitted paths that were accepted, derived as the submitted item paths
 * minus the held/skipped/failed paths (the conservation invariant makes this exactly
 * the accepted set). `accepted` stays a count on the wire; the UI recovers the paths
 * here so it can deselect those rows and avoid a double-submit re-send. Assumes the
 * submitted `path` values are unique, which holds for scan-generated UI rows.
 */
export function acceptedItemPaths(submitted: ImportConfirmItem[], result: ImportResult): Set<string> {
  const nonAccepted = new Set<string>([
    ...result.heldReview.map(h => h.path),
    ...result.skipped.map(s => s.path),
    ...result.failed.map(f => f.path),
  ]);
  return new Set(submitted.map(i => i.path).filter(p => !nonAccepted.has(p)));
}

/**
 * A run is fully clean only when the submitted aggregate is clean AND nothing was
 * left unsubmitted (mid-run transport failure) or diverted as too-large (#1831).
 * Green toast + navigation gate on this, not on the aggregate alone — otherwise a
 * run with a never-sent remainder or a too-large row would report a false success.
 */
export function isChunkedCleanImport(res: ChunkedConfirmResult): boolean {
  return isCleanImport(res.aggregateResult) && res.unsubmitted.count === 0 && res.tooLarge.count === 0;
}

/**
 * Build the consolidated outcome toast for a chunked confirm run (#1831). When the
 * run submitted everything it packed, this defers to {@link buildOutcomeToast} over
 * the aggregate (identical to the single-request behavior). When a chunk failed
 * mid-run or rows were diverted as too-large, it appends actionable, resubmit-safe
 * clauses distinguishing the failing in-flight chunk, the never-sent remainder, and
 * the too-large rows — and never colours the result green.
 */
export function buildChunkedOutcomeToast(res: ChunkedConfirmResult, acceptedVerb: string): OutcomeToast | null {
  const agg = res.aggregateResult;
  const { unsubmitted, tooLarge } = res;
  if (unsubmitted.count === 0 && tooLarge.count === 0) {
    return buildOutcomeToast(agg, acceptedVerb);
  }

  const parts: string[] = [];
  if (agg.accepted > 0) parts.push(`${agg.accepted} ${acceptedVerb}`);
  if (agg.skipped.length > 0) parts.push(importSkipSummary(agg.skipped));
  if (agg.failed.length > 0) parts.push(`${agg.failed.length} failed`);
  if (unsubmitted.inFlight > 0) {
    // A deterministic 413 fails identically on every retry, so it must NOT claim
    // resubmitting is safe — name the too-large cause with actionable wording instead (#1833).
    parts.push(unsubmitted.reasonKind === 'too-large'
      ? `${unsubmitted.inFlight} not sent — the import request was too large; select fewer books and try again`
      : `${unsubmitted.inFlight} not confirmed — connection failed mid-request; resubmitting is safe`);
  }
  if (unsubmitted.remainder > 0) parts.push(`${unsubmitted.remainder} not submitted`);
  if (tooLarge.count > 0) parts.push(`${tooLarge.count} too large to submit — remove or re-scan`);

  // A transport failure (unsubmitted) or a hard confirm failure reads red; a batch that
  // only skipped or diverted too-large rows reads amber.
  const severity: OutcomeToast['severity'] = unsubmitted.count > 0 || agg.failed.length > 0 ? 'error' : 'warning';
  return { severity, message: parts.join(' · ') };
}

/**
 * Import-domain wording for a confirm/import failure (#1831). A 413 (from either the
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
