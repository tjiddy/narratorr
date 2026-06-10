import type { QualityGateReason } from '../../shared/schemas.js';

export class QualityGateServiceError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS',
  ) {
    super(message);
    this.name = 'QualityGateServiceError';
  }
}

/**
 * Canonical reason JSON for every quality gate decision.
 * Derived from the shared `qualityGateReasonSchema` (single source of the shape).
 */
export type QualityDecisionReason = QualityGateReason;

export const DURATION_TOLERANCE = 0.15; // 15%

export const NULL_REASON: QualityDecisionReason = {
  action: 'held',
  mbPerHour: null,
  existingMbPerHour: null,
  narratorMatch: null,
  existingNarrator: null,
  downloadNarrator: null,
  durationDelta: null,
  existingDuration: null,
  downloadedDuration: null,
  codec: null,
  channels: null,
  existingCodec: null,
  existingChannels: null,
  probeFailure: false,
  probeError: null,
  holdReasons: [],
};
