import { z } from 'zod';

export const outputFormatSchema = z.enum(['m4b', 'mp3']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const mergeBehaviorSchema = z.enum(['always', 'multi-file-only', 'never']);
export type MergeBehavior = z.infer<typeof mergeBehaviorSchema>;

export const processingSettingsSchema = z.object({
  ffmpegPath: z.string().default(''),
  outputFormat: outputFormatSchema.default('m4b'),
  keepOriginalBitrate: z.boolean().default(false),
  bitrate: z.number().int().min(32).max(512).default(128),
  mergeBehavior: mergeBehaviorSchema.default('multi-file-only'),
  maxConcurrentProcessing: z.number().int().min(1).default(2),
  postProcessingScript: z.string().default(''),
  postProcessingScriptTimeout: z.number().int().min(1).default(300),
});

// Form schema: NaN-to-undefined coercion for cleared numeric inputs lives at
// the form layer via setValueAs (see ProcessingSettingsSection). Conditional
// validation (script path → timeout required) lives in the composed
// superRefine in registry.ts.
export const processingFormSchema = z.object({
  ffmpegPath: z.string(),
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: z.number().int().min(32).max(512),
  mergeBehavior: mergeBehaviorSchema,
  maxConcurrentProcessing: z.number().int().min(1),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: z.number().int().min(1).optional(),
});
