import { z } from 'zod';

/**
 * Validates a persisted `held_for_review` reason blob before it is rendered by
 * `QualityComparisonPanel` (used in `HeldForReviewDetails`). Every key is required
 * (a missing key is a hard parse failure routed to the generic fallback); `T | null`
 * fields use `.nullable()` so a present `null` is accepted. The three non-null fields
 * (`action`, `probeFailure`, `holdReasons`) reject `null`/wrong types — the panel reads
 * them unguarded and would render "NaN MB/hr" or throw on `.includes()`/`.length`
 * otherwise. Mirrors `QualityGateData` (src/client/lib/api/activity.ts) / `NULL_REASON`
 * (src/server/services/quality-gate.types.ts). Default `.strip()` tolerates extra keys
 * from other code versions.
 */
export const qualityGateReasonSchema = z.object({
  action: z.enum(['imported', 'rejected', 'held']),
  mbPerHour: z.number().nullable(),
  existingMbPerHour: z.number().nullable(),
  narratorMatch: z.boolean().nullable(),
  existingNarrator: z.string().nullable(),
  downloadNarrator: z.string().nullable(),
  durationDelta: z.number().nullable(),
  existingDuration: z.number().nullable(),
  downloadedDuration: z.number().nullable(),
  codec: z.string().nullable(),
  channels: z.number().nullable(),
  existingCodec: z.string().nullable(),
  existingChannels: z.number().nullable(),
  probeFailure: z.boolean(),
  probeError: z.string().nullable(),
  holdReasons: z.array(z.string()),
});
