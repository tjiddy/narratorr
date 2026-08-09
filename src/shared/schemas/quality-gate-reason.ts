import { z } from 'zod';

// Persisted blobs outlive app versions. Keep the original fields required, but add
// future fields as .nullish() so legacy rows still parse; unknown fields are stripped.
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

export type QualityGateReason = z.infer<typeof qualityGateReasonSchema>;
