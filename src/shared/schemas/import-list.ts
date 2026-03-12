import { z } from 'zod';
import { IMPORT_LIST_REGISTRY } from '../import-list-registry.js';

// ============================================================================
// Import List schemas
// ============================================================================

export const importListTypeSchema = z.enum(['abs', 'nyt', 'hardcover']);

function validateRequiredSettings(data: { type: string; settings: Record<string, unknown> }, ctx: z.RefinementCtx) {
  const meta = IMPORT_LIST_REGISTRY[data.type];
  if (!meta) return;
  for (const field of meta.requiredFields) {
    if (!data.settings[field.path]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
    }
  }
}

export const createImportListSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: importListTypeSchema,
  enabled: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes').default(1440),
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateRequiredSettings);

export const updateImportListSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: importListTypeSchema.optional(),
  enabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes').optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
  // Validate provider-specific settings when both type and settings are provided
  if (data.type && data.settings) {
    validateRequiredSettings({ type: data.type, settings: data.settings }, ctx);
  }
});

export const previewImportListSchema = z.object({
  type: importListTypeSchema,
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateRequiredSettings);

export type CreateImportListInput = z.infer<typeof createImportListSchema>;
export type UpdateImportListInput = z.infer<typeof updateImportListSchema>;
export type PreviewImportListInput = z.infer<typeof previewImportListSchema>;

// Form schema: all possible settings fields optional, superRefine validates per-type
export const createImportListFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: importListTypeSchema,
  enabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes'),
  settings: z.object({
    // ABS
    serverUrl: z.string().optional(),
    apiKey: z.string().optional(),
    libraryId: z.string().optional(),
    // NYT
    list: z.string().optional(),
    // Hardcover
    shelfId: z.string().optional(),
    listType: z.enum(['trending', 'shelf']).optional(),
  }),
}).superRefine(validateRequiredSettings);

export type CreateImportListFormData = z.infer<typeof createImportListFormSchema>;
