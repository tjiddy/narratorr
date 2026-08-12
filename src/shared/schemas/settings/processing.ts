import { z } from 'zod';

export const outputFormatSchema = z.enum(['m4b', 'mp3']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

// Reuse bare validators: picking from defaulted schemas makes inputs optional under Zod v4.
export const bitrateField = z.number().int().min(32).max(512);
export const maxConcurrentProcessingField = z.number().int().min(1).max(8);
export const postProcessingScriptTimeoutField = z.number().int().min(1);

export const processingSettingsSchema = z.object({
  outputFormat: outputFormatSchema.default('m4b'),
  keepOriginalBitrate: z.boolean().default(true),
  bitrate: bitrateField.default(128),
  maxConcurrentProcessing: maxConcurrentProcessingField.default(1),
  // Download completions only; library and manual imports never auto-merge.
  autoMergeDownloads: z.boolean().default(false),
  postProcessingScript: z.string().default(''),
  postProcessingScriptTimeout: postProcessingScriptTimeoutField.default(300),
});

// Script/timeout conditional validation is composed in registry.ts.
export const processingFormSchema = z.object({
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: bitrateField,
  maxConcurrentProcessing: maxConcurrentProcessingField,
  autoMergeDownloads: z.boolean(),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: postProcessingScriptTimeoutField.optional(),
});
