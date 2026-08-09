import type { MatchResult } from './api/library-scan.js';
import type { BookMetadata } from './api/books.js';
import { withinDurationTolerance } from '@shared/duration-tolerance.js';
import { formatDurationSeconds } from '@shared/format-duration.js';

/**
 * A fresh re-pick promotes `none`, re-evaluates medium duration evidence, and resolves other
 * medium ambiguity; the existing metadata reference is a no-op and high never demotes. An
 * out-of-band duration mismatch remains provisional for chapter corroboration.
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
    // An explicit re-pick resolves non-duration ambiguity.
    return promoteMatchToHigh(matchResult);
  }
  return matchResult;
}

/** Promotes to high without stale reason fields; shared by synchronous and corroboration paths. */
export function promoteMatchToHigh(matchResult: MatchResult): MatchResult {
  const { reason: _reason, reasonKind: _reasonKind, ...rest } = matchResult;
  return { ...rest, confidence: 'high' };
}

/** Re-evaluates with picked minutes converted to seconds and the shared tolerance. */
function reevaluateDurationRepick(matchResult: MatchResult, picked: BookMetadata): MatchResult {
  const scanned = matchResult.scannedSeconds;
  const pickedMinutes = picked.duration;
  // Scanner-first precedence avoids blaming the picked edition when scan evidence is corrupt.
  if (scanned == null || scanned <= 0) {
    return { ...matchResult, confidence: 'medium', reason: 'Scanned duration unavailable — cannot verify', reasonKind: 'missing-duration' };
  }
  if (pickedMinutes == null || pickedMinutes <= 0) {
    return { ...matchResult, confidence: 'medium', reason: 'Best match missing duration — cannot verify', reasonKind: 'missing-duration' };
  }
  if (withinDurationTolerance(pickedMinutes * 60, scanned)) {
    return promoteMatchToHigh(matchResult);
  }
  return {
    ...matchResult,
    confidence: 'medium',
    reason: `Duration mismatch — scanned ${formatDurationSeconds(scanned)} vs expected ${formatDurationSeconds(pickedMinutes * 60)}`,
    reasonKind: 'duration-mismatch',
  };
}
