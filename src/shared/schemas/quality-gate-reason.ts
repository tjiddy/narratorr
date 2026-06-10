import { z } from 'zod';

/**
 * Single source of truth for the persisted `held_for_review` quality-gate reason shape.
 *
 * This schema validates a `book_events.reason` blob before it is rendered by
 * `QualityComparisonPanel` (client) or returned by the server read path
 * (`getQualityGateData` / `getQualityGateDataBatch`). The three non-null fields
 * (`action`, `probeFailure`, `holdReasons`) reject `null`/wrong types — the panel reads
 * them unguarded and would render "NaN MB/hr" or throw on `.includes()`/`.length`
 * otherwise. `T | null` fields use `.nullable()` so a present `null` is accepted.
 * Default `.strip()` tolerates extra keys from other code versions.
 *
 * Both `QualityDecisionReason` (server, src/server/services/quality-gate.types.ts) and
 * `QualityGateData` (client, src/client/lib/api/activity.ts) derive from this via
 * `z.infer` — do NOT restate the shape anywhere else; that re-introduces the three-copy
 * drift class this schema exists to kill.
 *
 * CONTRACT — field-addition rule: the 16 launch fields below are all REQUIRED. A missing
 * key is a hard parse failure (the server read path collapses it to `null`; the client
 * render path routes it to the generic fallback). This "every key required" rule is only
 * safe pre-1.0. Any field added AFTER the 1.0 public release MUST be declared `.nullish()`
 * (optional + nullable) — otherwise a legacy row persisted before the field existed fails
 * the parse and silently downgrades to the fallback for every post-1.0 user (the #1305
 * legacy-downgrade regression class).
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

/** Canonical reason shape derived from the schema — the only declaration of these keys. */
export type QualityGateReason = z.infer<typeof qualityGateReasonSchema>;
