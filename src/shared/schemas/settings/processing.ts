import { z } from 'zod';

export const outputFormatSchema = z.enum(['m4b', 'mp3']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const mergeBehaviorSchema = z.enum(['always', 'multi-file-only', 'never']);
export type MergeBehavior = z.infer<typeof mergeBehaviorSchema>;

export const processingSettingsSchema = z.object({
  outputFormat: outputFormatSchema.default('m4b'),
  keepOriginalBitrate: z.boolean().default(true),
  bitrate: z.number().int().min(32).max(512).default(128),
  mergeBehavior: mergeBehaviorSchema.default('multi-file-only'),
  maxConcurrentProcessing: z.number().int().min(1).max(8).default(1),
  // Opt-in auto-merge (#1836): when a completed DOWNLOAD lands as a multi-file set, enqueue a
  // merge into the existing bounded merge queue. Downloads only — never Library/Manual Import.
  // Default OFF; absent from older payloads coerces to false via this default.
  autoMergeDownloads: z.boolean().default(false),
  postProcessingScript: z.string().default(''),
  postProcessingScriptTimeout: z.number().int().min(1).default(300),
});

// Form schema: NaN-to-undefined coercion for cleared numeric inputs lives at
// the form layer via setValueAs (see ProcessingSettingsSection). Conditional
// validation (script path → timeout required) lives in the composed
// superRefine in registry.ts.
export const processingFormSchema = z.object({
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: z.number().int().min(32).max(512),
  mergeBehavior: mergeBehaviorSchema,
  maxConcurrentProcessing: z.number().int().min(1).max(8),
  autoMergeDownloads: z.boolean(),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: z.number().int().min(1).optional(),
});
