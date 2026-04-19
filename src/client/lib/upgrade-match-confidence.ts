import type { MatchResult } from './api/library-scan.js';
import type { BookMetadata } from './api/books.js';

/**
 * Upgrade a row's match confidence when the user selects provider metadata in the import editor.
 *
 * none → medium: user provided metadata on an unmatched row (no reference check — a fresh
 *   selection on an unmatched row always signals intent).
 * medium → high: user re-selected on a review row. Keyed on reference identity, not deep
 *   equality — the pre-populated bestMatch is passed back by-reference when the user saves
 *   without touching the picker, and that must NOT upgrade to high. The modal spreads into
 *   a fresh object on explicit re-selection, which is what triggers the upgrade.
 *
 * `reason` is cleared only on medium → high (user has overridden the suggested match);
 * none → medium leaves `reason` untouched.
 */
export function upgradeMatchConfidence(
  matchResult: MatchResult | undefined,
  newMetadata: BookMetadata | undefined,
  currentEditedMetadata: BookMetadata | undefined,
): MatchResult | undefined {
  if (!matchResult || !newMetadata) return matchResult;
  if (matchResult.confidence === 'none') {
    return { ...matchResult, confidence: 'medium' };
  }
  if (matchResult.confidence === 'medium' && newMetadata !== currentEditedMetadata) {
    return { ...matchResult, confidence: 'high', reason: undefined };
  }
  return matchResult;
}
