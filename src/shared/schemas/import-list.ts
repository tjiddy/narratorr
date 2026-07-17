import { z } from 'zod';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES, type ImportListType } from '../import-list-registry';
import { parseHardcoverListUrl } from '../hardcover-list-url.js';

// ============================================================================
// Import List schemas
// ============================================================================

export const importListTypeSchema = z.enum(IMPORT_LIST_TYPES);

// ── Per-adapter settings schemas (strict — rejects unknown fields) ──────────

export const nytSettingsSchema = z.object({
  apiKey: z.string().trim().min(1),
  list: z.string().trim().optional(),
}).strict();

// #1879 — strict `50 | 100 | 'all'` Import Max (custom lists). A raw union of
// literals, NOT a coercion: `75`/`0`/`'50'` are rejected outright.
const hardcoverImportMaxSchema = z.union([z.literal(50), z.literal(100), z.literal('all')]);

// Type-scoped parsed Hardcover settings. Every branch keeps `apiKey` plus only
// the effective list type's own keys; the `.transform` below strips any stale
// foreign key the input carried (#1879 AC10). `listType` stays optional — an
// omitted value is treated exactly as `trending` (factory default `registry.ts`).
export type HardcoverSettings = {
  apiKey: string;
  listType?: 'trending' | 'shelf' | 'custom';
  shelfId?: number;
  listUrl?: string;
  importMax?: 50 | 100 | 'all';
};

export const hardcoverSettingsSchema = z.object({
  apiKey: z.string().trim().min(1),
  listType: z.enum(['trending', 'shelf', 'custom']).optional(),
  shelfId: z.coerce.number().int().positive().optional(),
  // Free user text (#1879 AC2) — `.trim().min(1)` rejects spaces-only before URL parsing.
  listUrl: z.string().trim().min(1).optional(),
  importMax: hardcoverImportMaxSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.listType === 'shelf' && data.shelfId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shelfId'], message: 'Shelf ID is required when list type is "shelf"' });
  }
  if (data.listType === 'custom') {
    if (data.listUrl === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['listUrl'], message: 'List URL is required when list type is "custom"' });
    } else if (parseHardcoverListUrl(data.listUrl) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['listUrl'], message: 'Not a Hardcover list URL' });
    }
  }
}).transform((data): HardcoverSettings => {
  // Runs only on a clean parse (Zod skips the transform when superRefine added
  // an issue), so the `!` assertions below are guaranteed present. Output is
  // type-scoped: only the effective list type's own keys survive.
  if (data.listType === 'custom') {
    return { apiKey: data.apiKey, listType: 'custom', listUrl: data.listUrl!, importMax: data.importMax ?? 50 };
  }
  if (data.listType === 'shelf') {
    return { apiKey: data.apiKey, listType: 'shelf', ...(data.shelfId !== undefined && { shelfId: data.shelfId }) };
  }
  // trending OR omitted listType — strip shelfId/listUrl/importMax.
  return { apiKey: data.apiKey, ...(data.listType !== undefined && { listType: data.listType }) };
});

// ── Settings types and dispatch map ─────────────────────────────────────────

export type NytSettings = z.infer<typeof nytSettingsSchema>;

export type ImportListSettingsMap = {
  nyt: NytSettings;
  hardcover: HardcoverSettings;
};

export type ImportListSettings = ImportListSettingsMap[ImportListType];

export const importListSettingsSchemas: Record<ImportListType, z.ZodTypeAny> = {
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

export type PreviewImportListInput = z.infer<typeof previewImportListSchema>;

// ── Form schema (unchanged — uses superRefine + registry.requiredFields for zodResolver compat) ──

export const createImportListFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: importListTypeSchema,
  enabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes'),
  settings: z.object({
    // Shared
    apiKey: z.string().optional(),
    // NYT
    list: z.string().optional(),
    // Hardcover
    shelfId: z.number().int().positive().optional(),
    listType: z.enum(['trending', 'shelf', 'custom']).optional(),
    listUrl: z.string().optional(),
    importMax: hardcoverImportMaxSchema.optional(),
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
