import { z } from 'zod';
import { INDEXER_REGISTRY, INDEXER_TYPES } from '../indexer-registry';

// ============================================================================
// Indexer schemas
// ============================================================================

export const indexerTypeSchema = z.enum(INDEXER_TYPES);

/** Trim string values for known credential fields in the settings record. */
function trimSettingsCredentials(settings: Record<string, unknown>): Record<string, unknown> {
  const result = { ...settings };
  for (const key of ['apiUrl', 'apiKey']) {
    if (typeof result[key] === 'string') {
      result[key] = (result[key] as string).trim();
    }
  }
  return result;
}

// Server-side: accepts any settings shape (type-specific validation is client-side only)
export const createIndexerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()).transform(trimSettingsCredentials),
});

export const updateIndexerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).transform(trimSettingsCredentials).optional(),
});

// Output types (after Zod applies defaults)
export type CreateIndexerInput = z.infer<typeof createIndexerSchema>;
export type UpdateIndexerInput = z.infer<typeof updateIndexerSchema>;

// Form schema: all possible settings fields optional, superRefine validates per-type
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
    searchType: z.number().optional(),
    isVip: z.boolean().optional(),
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
  const proxyUrl = data.settings.flareSolverrUrl?.replace(/\/+$/, '').trim();
  if (proxyUrl) {
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
