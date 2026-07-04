import type { ImportResult, ImportConfirmItem } from '@/lib/api';

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

/** Human phrase for the skipped bucket — names the incumbent title when a single item carries one. */
export function importSkipSummary(skipped: ImportResult['skipped']): string {
  if (skipped.length === 1 && skipped[0]!.existingTitle) {
    return `already in your library as '${skipped[0]!.existingTitle}'`;
  }
  return `${skipped.length} already in your library`;
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
