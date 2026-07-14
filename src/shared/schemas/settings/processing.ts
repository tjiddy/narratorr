import { z } from 'zod';

export const outputFormatSchema = z.enum(['m4b', 'mp3']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const mergeBehaviorSchema = z.enum(['always', 'multi-file-only', 'never']);
export type MergeBehavior = z.infer<typeof mergeBehaviorSchema>;

// Canonical field validators — the numeric bounds live here ONCE. `processingSettingsSchema`
// wraps them with `.default(...)`; the client Audio Tools / Post Processing page schemas consume
// the bare validators, so a bound change can't drift the UI from the backend. Kept as shared base
// validators rather than `z.pick()` from the defaulted schema: ZodDefault under
// exactOptionalPropertyTypes makes a picked field optional-in, which clashes with the required
// page-form inputs (the reason the earlier `.pick()` route was rejected).
export const bitrateField = z.number().int().min(32).max(512);
export const maxConcurrentProcessingField = z.number().int().min(1).max(8);
export const postProcessingScriptTimeoutField = z.number().int().min(1);

export const processingSettingsSchema = z.object({
  outputFormat: outputFormatSchema.default('m4b'),
  keepOriginalBitrate: z.boolean().default(true),
  bitrate: bitrateField.default(128),
  mergeBehavior: mergeBehaviorSchema.default('multi-file-only'),
  maxConcurrentProcessing: maxConcurrentProcessingField.default(1),
  // Opt-in auto-merge (#1836): when a completed DOWNLOAD lands as a multi-file set, enqueue a
  // merge into the existing bounded merge queue. Downloads only — never Library/Manual Import.
  // Default OFF; absent from older payloads coerces to false via this default.
  autoMergeDownloads: z.boolean().default(false),
  postProcessingScript: z.string().default(''),
  postProcessingScriptTimeout: postProcessingScriptTimeoutField.default(300),
});

// Form schema: NaN-to-undefined coercion for cleared numeric inputs lives at
// the form layer via setValueAs (see ProcessingSettingsSection). Conditional
// validation (script path → timeout required) lives in the composed
// superRefine in registry.ts.
export const processingFormSchema = z.object({
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: bitrateField,
  mergeBehavior: mergeBehaviorSchema,
  maxConcurrentProcessing: maxConcurrentProcessingField,
  autoMergeDownloads: z.boolean(),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: postProcessingScriptTimeoutField.optional(),
});
