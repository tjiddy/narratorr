import { z } from 'zod';

const RECORDING_VERDICT_VALUES = ['same-recording', 'different-recording', 'review'] as const;
export const recordingVerdictSchema = z.enum(RECORDING_VERDICT_VALUES);
export type RecordingVerdict = (typeof RECORDING_VERDICT_VALUES)[number];

// Machine-readable reasons, distinct from the user-facing reviewReason text.
const RECORDING_REVIEW_REASON_VALUES = ['narrator-no-signal', 'duration-mismatch', 'production-type-mismatch'] as const;
export const recordingReviewReasonSchema = z.enum(RECORDING_REVIEW_REASON_VALUES);
export type RecordingReviewReason = (typeof RECORDING_REVIEW_REASON_VALUES)[number];
