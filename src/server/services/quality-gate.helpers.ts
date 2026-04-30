import { resolveBookQualityInputs } from '../../core/utils/quality.js';
import { tokenizeNarrators, normalizeNarrator } from '../../core/utils/similarity.js';
import type { QualityDecisionReason } from './quality-gate.types.js';
import { DURATION_TOLERANCE } from './quality-gate.types.js';
import type { BookRow } from './types.js';

type BookWithNarrators = BookRow & { narrators?: Array<{ name: string }> };

interface ScanResult {
  totalSize: number;
  totalDuration: number;
  tagNarrator?: string;
  codec?: string;
  channels?: number;
}

/**
 * Pure quality assessment: compares scan results against existing book data
 * and returns the decision reason (without the final action, which depends on
 * side-effect branches in the caller).
 */
// eslint-disable-next-line complexity -- linear quality assessment with null-guarded branches
export function buildQualityAssessment(
  scanResult: ScanResult,
  book: BookWithNarrators | null,
): QualityDecisionReason {
  const holdReasons: string[] = [];
  const newSizeBytes = scanResult.totalSize;
  const newDurationSeconds = scanResult.totalDuration;
  const newMbPerHour = newDurationSeconds > 0
    ? (newSizeBytes / (1024 * 1024)) / (newDurationSeconds / 3600)
    : null;

  // Resolve existing book quality (cached — reused for duration delta below)
  let existingMbPerHour: number | null = null;
  let existingCodec: string | null = null;
  let existingChannels: number | null = null;
  let existingDuration: number | null = null;
  const existingInputs = book ? resolveBookQualityInputs(book) : null;
  if (book && existingInputs) {
    if (existingInputs.sizeBytes && existingInputs.durationSeconds && existingInputs.durationSeconds > 0) {
      existingMbPerHour = (existingInputs.sizeBytes / (1024 * 1024)) / (existingInputs.durationSeconds / 3600);
    }
    // Populate existing audio metadata (only for books with files on disk)
    if (book.path !== null) {
      existingCodec = book.audioCodec || null;
      existingChannels = book.audioChannels || null;
      existingDuration = existingInputs.durationSeconds;
    }
  }

  // Downloaded duration (null when 0 — no valid duration)
  const downloadedDuration = newDurationSeconds > 0 ? newDurationSeconds : null;

  // Check narrator match (skip for first imports — no existing file to protect)
  let narratorMatch: boolean | null = null;
  let existingNarrator: string | null = null;
  let downloadNarrator: string | null = null;
  // Use narrator array directly — no re-join+split to avoid punctuation heuristics
  const existingNarratorNames = book?.narrators?.map(n => normalizeNarrator(n.name)).filter(n => n.length > 0) ?? [];
  if (book && book.path !== null && scanResult.tagNarrator && existingNarratorNames.length > 0) {
    const downloadTokens = tokenizeNarrators(scanResult.tagNarrator).map(normalizeNarrator).filter(n => n.length > 0);
    // Skip if download tag produces no tokens after normalization (AC5)
    if (downloadTokens.length > 0) {
      existingNarrator = book.narrators!.map(n => n.name).join(', ');
      downloadNarrator = scanResult.tagNarrator;
      const existingSet = new Set(existingNarratorNames);
      narratorMatch = downloadTokens.some(n => existingSet.has(n));
      if (!narratorMatch) {
        holdReasons.push('narrator_mismatch');
      }
    }
  }

  // Check duration delta (skip for placeholder books with no existing files)
  let durationDelta: number | null = null;
  if (book && book.path !== null && existingInputs) {
    if (existingInputs.durationSeconds && existingInputs.durationSeconds > 0 && newDurationSeconds > 0) {
      durationDelta = (newDurationSeconds - existingInputs.durationSeconds) / existingInputs.durationSeconds;
      // Hold if delta exceeds ±15% (boundary exclusive: exactly ±15% is OK)
      if (Math.abs(durationDelta) > DURATION_TOLERANCE) {
        holdReasons.push('duration_delta');
      }
    }
  }

  // Check if existing book has no quality data (only applies when book has files on disk)
  const noExistingQuality = existingMbPerHour === null;
  if (noExistingQuality && book && book.path !== null) {
    holdReasons.push('no_quality_data');
  }

  return {
    action: 'held', // caller overrides based on decision tree
    mbPerHour: newMbPerHour,
    existingMbPerHour,
    narratorMatch,
    existingNarrator,
    downloadNarrator,
    durationDelta,
    existingDuration,
    downloadedDuration,
    codec: scanResult.codec || null,
    channels: scanResult.channels || null,
    existingCodec,
    existingChannels,
    probeFailure: false,
    probeError: null,
    holdReasons,
  };
}
