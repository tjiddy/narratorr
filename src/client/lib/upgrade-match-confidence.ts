import type { MatchResult } from './api/library-scan.js';
import type { BookMetadata } from './api/books.js';
import { withinDurationTolerance } from '../../shared/duration-tolerance.js';
import { formatDurationSeconds } from '../../shared/format-duration.js';

/**
 * Upgrade a row's match confidence when the user selects provider metadata in the import editor.
 *
 * none → medium: user provided metadata on an unmatched row (no reference check — a fresh
 *   selection on an unmatched row always signals intent). `reason`/`reasonKind` are left
 *   untouched.
 *
 * medium → (re-evaluate): user re-selected on a Review row. Keyed on reference identity, NOT
 *   deep equality — the pre-populated `bestMatch` is passed back by-reference when the user
 *   saves without touching the picker, and that must NOT upgrade (#1929, the by-reference
 *   no-op contract). The modal spreads into a fresh object on explicit re-selection, which is
 *   what fires this branch. What happens next depends on the Review's evidence class:
 *
 *   - `duration-mismatch` / `missing-duration` (#1929): re-evaluate the DURATION evidence
 *     against the newly picked edition instead of blanket-clearing — re-picking the same
 *     edition on a file-vs-edition duration disagreement resolves nothing, so a false green
 *     would read as "the system validated this version" when it only means "you touched the
 *     picker". Precedence: (1) scanned runtime missing → stay Review, truthful
 *     "Scanned duration unavailable" cannot-verify; (2) picked edition has no runtime → stay
 *     Review, "Best match missing duration" cannot-verify; (3) picked `duration * 60` within
 *     the shared band of `scannedSeconds` → clear to high (legitimate, incl. a DIFFERENT
 *     edition that fits); (4) out of band → stay Review with the reason re-rendered against
 *     the PICKED edition's numbers.
 *   - `no-duration-data` / `undefined` (attempt-cap, narrator-cap, legacy medium): pure
 *     match-identity ambiguity — an explicit re-pick legitimately resolves it, so clear to
 *     high and drop BOTH `reason` and `reasonKind` (no stale discriminator survives onto a
 *     high result).
 *
 * `scannedSeconds` is a file property, never stripped on any outcome. `high` rows are out of
 * scope: an explicit re-pick on an already-Matched row stays `high`, unchanged (#1929).
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
    if (matchResult.reasonKind === 'duration-mismatch' || matchResult.reasonKind === 'missing-duration') {
      return reevaluateDurationRepick(matchResult, newMetadata);
    }
    // `no-duration-data` / undefined legacy: explicit re-pick clears the ambiguity.
    return clearToHigh(matchResult);
  }
  return matchResult;
}

/** Clear a medium Review row to high, dropping BOTH `reason` and `reasonKind` (#1929 F4 —
 *  no stale discriminator survives onto a high result) while preserving `scannedSeconds`. */
function clearToHigh(matchResult: MatchResult): MatchResult {
  const { reason: _reason, reasonKind: _reasonKind, ...rest } = matchResult;
  return { ...rest, confidence: 'high' };
}

/**
 * Re-evaluate the duration evidence of a `duration-mismatch`/`missing-duration` Review row
 * against the freshly picked edition. The MINUTES→SECONDS `* 60` on the picked edition's
 * `duration` is mandatory (learning `book-duration-minutes-vs-quality-seconds`: a raw-minutes
 * argument makes the band 60× too loose). Reuses the shared band + formatter — no new band.
 */
function reevaluateDurationRepick(matchResult: MatchResult, picked: BookMetadata): MatchResult {
  const scanned = matchResult.scannedSeconds;
  const pickedMinutes = picked.duration;
  // (1) Scanner runtime missing/non-positive → cannot verify. Defensive: the server only
  // emits these reasonKinds when scannedSeconds > 0, so reaching here implies missing/corrupt
  // transport — blaming the best match would be false, the SCAN side is what's missing.
  if (scanned == null || scanned <= 0) {
    return { ...matchResult, confidence: 'medium', reason: 'Scanned duration unavailable — cannot verify', reasonKind: 'missing-duration' };
  }
  // (2) Picked edition has no positive runtime → cannot verify (the existing best-match string).
  if (pickedMinutes == null || pickedMinutes <= 0) {
    return { ...matchResult, confidence: 'medium', reason: 'Best match missing duration — cannot verify', reasonKind: 'missing-duration' };
  }
  // (3) Within the shared band → clear to high (legitimate, incl. a different edition that fits).
  if (withinDurationTolerance(pickedMinutes * 60, scanned)) {
    return clearToHigh(matchResult);
  }
  // (4) Out of band → stay Review, reason re-rendered against the PICKED edition's numbers.
  return {
    ...matchResult,
    confidence: 'medium',
    reason: `Duration mismatch — scanned ${formatDurationSeconds(scanned)} vs expected ${formatDurationSeconds(pickedMinutes * 60)}`,
    reasonKind: 'duration-mismatch',
  };
}
