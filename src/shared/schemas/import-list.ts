import { z } from 'zod';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES, type ImportListType } from '../import-list-registry';
import { parseHardcoverListUrl } from '../hardcover-list-url.js';
import { HARDCOVER_LIST_TYPES, HARDCOVER_IMPORT_MAX_VALUES, type HardcoverListType, type HardcoverImportMax } from '../hardcover-list-types.js';

export const importListTypeSchema = z.enum(IMPORT_LIST_TYPES);

export const nytSettingsSchema = z.object({
  apiKey: z.string().trim().min(1),
  list: z.string().trim().optional(),
}).strict();

const hardcoverImportMaxSchema = z.literal(HARDCOVER_IMPORT_MAX_VALUES);

// Parsing strips keys from inactive list types; omitted listType behaves as trending.
export type HardcoverSettings = {
  apiKey: string;
  listType?: HardcoverListType;
  shelfId?: number;
  listUrl?: string;
  importMax?: HardcoverImportMax;
};

export const hardcoverSettingsSchema = z.object({
  apiKey: z.string().trim().min(1),
  listType: z.enum(HARDCOVER_LIST_TYPES).optional(),
  shelfId: z.coerce.number().int().positive().optional(),
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
  // Zod skips transforms after refinement errors, so custom listUrl is present here.
  if (data.listType === 'custom') {
    return { apiKey: data.apiKey, listType: 'custom', listUrl: data.listUrl!, importMax: data.importMax ?? 50 };
  }
  if (data.listType === 'shelf') {
    return { apiKey: data.apiKey, listType: 'shelf', ...(data.shelfId !== undefined && { shelfId: data.shelfId }) };
  }
  return { apiKey: data.apiKey, ...(data.listType !== undefined && { listType: data.listType }) };
});

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

export const createImportListFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: importListTypeSchema,
  enabled: z.boolean(),
  syncIntervalMinutes: z.number().int().min(5, 'Sync interval must be at least 5 minutes'),
  settings: z.object({
    apiKey: z.string().optional(),
    list: z.string().optional(),
    shelfId: z.number().int().positive().optional(),
    listType: z.enum(HARDCOVER_LIST_TYPES).optional(),
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
