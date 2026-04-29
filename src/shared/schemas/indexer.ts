import { z } from 'zod';
import { INDEXER_REGISTRY, INDEXER_TYPES, type IndexerType, type MamSearchType } from '../indexer-registry';
import { normalizeBaseUrl } from '../normalize-base-url.js';

// ============================================================================
// Indexer schemas
// ============================================================================

export const indexerTypeSchema = z.enum(INDEXER_TYPES);

// ── Per-adapter settings schemas (strict — rejects unknown fields) ──────────

const apiKeySettingsFields = {
  apiUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
  flareSolverrUrl: z.string().optional(),
  useProxy: z.boolean().optional(),
};

export const newznabSettingsSchema = z.object(apiKeySettingsFields).strict();
export const torznabSettingsSchema = z.object(apiKeySettingsFields).strict();

const mamSearchTypeServerSchema = z.union([
  z.enum(['all', 'active', 'fl', 'fl-VIP', 'VIP', 'nVIP']),
  z.number().int().min(0).max(3).transform((n): MamSearchType => {
    const map: Record<number, MamSearchType> = { 0: 'all', 1: 'active', 2: 'fl', 3: 'fl-VIP' };
    return map[n]!;
  }),
]);

export const mamSettingsSchema = z.object({
  mamId: z.string().trim().min(1),
  baseUrl: z.string().trim().optional(),
  searchLanguages: z.array(z.number()).optional(),
  searchType: mamSearchTypeServerSchema.optional(),
  isVip: z.boolean().optional(),
  mamUsername: z.string().optional(),
  classname: z.string().optional(),
  useProxy: z.boolean().optional(),
  flareSolverrUrl: z.string().optional(),
}).strict();

export const abbSettingsSchema = z.object({
  hostname: z.string().trim().min(1),
  pageLimit: z.number().int().min(1).max(10).optional(),
  flareSolverrUrl: z.string().optional(),
  useProxy: z.boolean().optional(),
}).strict();

// ── Settings types and dispatch map ─────────────────────────────────────────

export type NewznabSettings = z.infer<typeof newznabSettingsSchema>;
export type TorznabSettings = z.infer<typeof torznabSettingsSchema>;
export type MamSettings = z.infer<typeof mamSettingsSchema>;
export type AbbSettings = z.infer<typeof abbSettingsSchema>;

export type IndexerSettingsMap = {
  newznab: NewznabSettings;
  torznab: TorznabSettings;
  myanonamouse: MamSettings;
  abb: AbbSettings;
};

export type IndexerSettings = IndexerSettingsMap[IndexerType];

export const indexerSettingsSchemas: Record<IndexerType, z.ZodTypeAny> = {
  newznab: newznabSettingsSchema,
  torznab: torznabSettingsSchema,
  myanonamouse: mamSettingsSchema,
  abb: abbSettingsSchema,
};

// ── Server-side schemas ─────────────────────────────────────────────────────

function validateSettingsPerType(
  data: { type: string; settings: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  const schema = indexerSettingsSchemas[data.type as IndexerType];
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

export const createIndexerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateSettingsPerType);

export const updateIndexerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: indexerTypeSchema.optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
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

// Output types (after Zod applies defaults/transforms)
export type CreateIndexerInput = z.infer<typeof createIndexerSchema>;
export type UpdateIndexerInput = z.infer<typeof updateIndexerSchema>;

// ── Form schema (unchanged — uses superRefine + registry.requiredFields for zodResolver compat) ──

export const createIndexerFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    hostname: z.string().optional(),
    pageLimit: z.number().int().min(1).max(10).optional(),
    apiUrl: z.string().trim().optional(),
    apiKey: z.string().trim().optional(),
    flareSolverrUrl: z.string().optional(),
    mamId: z.string().optional(),
    baseUrl: z.string().trim().optional(),
    useProxy: z.boolean().optional(),
    searchLanguages: z.array(z.number()).optional(),
    searchType: z.enum(['all', 'active', 'fl', 'fl-VIP', 'VIP', 'nVIP']).optional(),
    isVip: z.boolean().optional(),
    mamUsername: z.string().optional(),
    classname: z.string().optional(),
  }),
}).superRefine((data, ctx) => {
  const meta = INDEXER_REGISTRY[data.type];
  if (meta) {
    for (const field of meta.requiredFields) {
      const value = data.settings[field.path as keyof typeof data.settings];
      if (!value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
      }
    }
  }

  // Validate FlareSolverr URL if provided (applies to all types)
  const proxyUrl = normalizeBaseUrl(data.settings.flareSolverrUrl)?.trim();
  if (proxyUrl === '********') {
    // Sentinel passthrough — persisted secret, skip validation
  } else if (proxyUrl) {
    try {
      new URL(proxyUrl);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'flareSolverrUrl'], message: 'Must be a valid URL' });
    }
    // Normalize: store the trimmed/stripped version
    data.settings.flareSolverrUrl = proxyUrl;
  } else {
    // Normalize empty strings to undefined
    data.settings.flareSolverrUrl = undefined;
  }
});

export type CreateIndexerFormData = z.infer<typeof createIndexerFormSchema>;
