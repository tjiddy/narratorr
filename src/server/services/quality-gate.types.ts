export class QualityGateServiceError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'INVALID_STATUS',
  ) {
    super(message);
    this.name = 'QualityGateServiceError';
  }
}

/** Canonical reason JSON for every quality gate decision. */
export interface QualityDecisionReason {
  action: 'imported' | 'rejected' | 'held';
  mbPerHour: number | null;
  existingMbPerHour: number | null;
  narratorMatch: boolean | null;
  existingNarrator: string | null;
  downloadNarrator: string | null;
  durationDelta: number | null;
  codec: string | null;
  channels: number | null;
  probeFailure: boolean;
  probeError: string | null;
  holdReasons: string[];
}

export const DURATION_TOLERANCE = 0.15; // 15%

export const NULL_REASON: QualityDecisionReason = {
  action: 'held',
  mbPerHour: null,
  existingMbPerHour: null,
  narratorMatch: null,
  existingNarrator: null,
  downloadNarrator: null,
  durationDelta: null,
  codec: null,
  channels: null,
  probeFailure: false,
  probeError: null,
  holdReasons: [],
};
