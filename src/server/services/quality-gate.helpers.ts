import { resolveBookQualityInputs } from '@core/utils/quality.js';
import { tokenizeNarrators, normalizeNarrator } from '@core/utils/similarity.js';
import type { QualityDecisionReason } from './quality-gate.types.js';
import { withinDurationTolerance } from '@shared/duration-tolerance.js';
import type { BookRow } from './types.js';

type BookWithNarrators = BookRow & { narrators?: Array<{ name: string }> };

interface ScanResult {
  totalSize: number;
  totalDuration: number;
  tagNarrator?: string;
  codec?: string;
  channels?: number;
}

/** Pure scan-vs-library assessment; the caller owns the final side-effecting action. */
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

  // Resolve once; duration and rate both reuse it.
  let existingMbPerHour: number | null = null;
  let existingCodec: string | null = null;
  let existingChannels: number | null = null;
  let existingDuration: number | null = null;
  const existingInputs = book ? resolveBookQualityInputs(book) : null;
  if (book && existingInputs) {
    if (existingInputs.sizeBytes && existingInputs.durationSeconds && existingInputs.durationSeconds > 0) {
      existingMbPerHour = (existingInputs.sizeBytes / (1024 * 1024)) / (existingInputs.durationSeconds / 3600);
    }
    if (book.path !== null) {
      existingCodec = book.audioCodec || null;
      existingChannels = book.audioChannels || null;
      existingDuration = existingInputs.durationSeconds;
    }
  }

  const downloadedDuration = newDurationSeconds > 0 ? newDurationSeconds : null;

  // Upgrade protection requires exact normalized identity; do not use the fuzzy match-job comparator.
  let narratorMatch: boolean | null = null;
  let existingNarrator: string | null = null;
  let downloadNarrator: string | null = null;
  // Normalize stored narrators directly to avoid re-splitting punctuation.
  const existingNarratorNames = book?.narrators?.map(n => normalizeNarrator(n.name)).filter(n => n.length > 0) ?? [];
  if (book && book.path !== null && scanResult.tagNarrator && existingNarratorNames.length > 0) {
    const downloadTokens = tokenizeNarrators(scanResult.tagNarrator).map(normalizeNarrator).filter(n => n.length > 0);
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

  let durationDelta: number | null = null;
  if (book && book.path !== null && existingInputs) {
    if (existingInputs.durationSeconds && existingInputs.durationSeconds > 0 && newDurationSeconds > 0) {
      // Persist relative delta for telemetry, but hold on the shared absolute-seconds tolerance.
      durationDelta = (newDurationSeconds - existingInputs.durationSeconds) / existingInputs.durationSeconds;
      if (!withinDurationTolerance(newDurationSeconds, existingInputs.durationSeconds)) {
        holdReasons.push('duration_delta');
      }
    }
  }

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
