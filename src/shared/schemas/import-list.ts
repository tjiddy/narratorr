import { z } from 'zod';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES, type ImportListType } from '../import-list-registry';

// ============================================================================
// Import List schemas
// ============================================================================

export const importListTypeSchema = z.enum(IMPORT_LIST_TYPES);

// ── Per-adapter settings schemas (strict — rejects unknown fields) ──────────

export const absSettingsSchema = z.object({
  serverUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  libraryId: z.string().trim().min(1),
}).strict();

export const nytSettingsSchema = z.object({
  apiKey: z.string().trim().min(1),
  list: z.string().trim().optional(),
}).strict();

export const hardcoverSettingsSchema = z.object({
  apiKey: z.string().trim().min(1),
  listType: z.enum(['trending', 'shelf']).optional(),
  shelfId: z.string().trim().optional(),
}).strict().superRefine((data, ctx) => {
  if (data.listType === 'shelf' && !data.shelfId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shelfId'], message: 'Shelf ID is required when list type is "shelf"' });
  }
});

// ── Settings types and dispatch map ─────────────────────────────────────────

export type AbsSettings = z.infer<typeof absSettingsSchema>;
export type NytSettings = z.infer<typeof nytSettingsSchema>;
export type HardcoverSettings = z.infer<typeof hardcoverSettingsSchema>;

export type ImportListSettingsMap = {
  abs: AbsSettings;
  nyt: NytSettings;
  hardcover: HardcoverSettings;
};

export type ImportListSettings = ImportListSettingsMap[ImportListType];

export const importListSettingsSchemas: Record<ImportListType, z.ZodTypeAny> = {
  abs: absSettingsSchema,
  nyt: nytSettingsSchema,
  hardcover: hardcoverSettingsSchema,
};

// ── Server-side schemas ─────────────────────────────────────────────────────

function validateSettingsPerType(
  data: { type: string; settings: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  const schema = importListSettingsSchemas[data.type as ImportListType];
  if (!schema) return;
  const result = schema.safeParse(data.settings);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['settings', ...issue.path] });
    }
  } else {
    data.settings = result.data as Record<string, unknown>;
  }
}

export const createImportListSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: importListTypeSchema,
  enabled: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes').default(1440),
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateSettingsPerType);

export const updateImportListSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: importListTypeSchema.optional(),
  enabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes').optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
  if (data.settings !== undefined && !data.type) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Type is required when settings are provided' });
    return;
  }
  if (data.settings !== undefined && data.type) {
    validateSettingsPerType(data as { type: string; settings: Record<string, unknown> }, ctx);
  }
});

export const previewImportListSchema = z.object({
  type: importListTypeSchema,
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateSettingsPerType);

export type CreateImportListInput = z.infer<typeof createImportListSchema>;
export type UpdateImportListInput = z.infer<typeof updateImportListSchema>;
export type PreviewImportListInput = z.infer<typeof previewImportListSchema>;

// ── Form schema (unchanged — uses superRefine + registry.requiredFields for zodResolver compat) ──

export const createImportListFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
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
}).superRefine((data, ctx) => {
  const meta = IMPORT_LIST_REGISTRY[data.type];
  if (!meta) return;
  for (const field of meta.requiredFields) {
    if (!data.settings[field.path as keyof typeof data.settings]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
    }
  }
});

export type CreateImportListFormData = z.infer<typeof createImportListFormSchema>;
