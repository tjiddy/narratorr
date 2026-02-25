import { z } from 'zod';

// ============================================================================
// Indexer schemas
// ============================================================================

export const indexerTypeSchema = z.enum(['abb', 'torznab', 'newznab']);

// Server-side: accepts any settings shape (type-specific validation is client-side only)
export const createIndexerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()),
});

export const updateIndexerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Output types (after Zod applies defaults)
export type CreateIndexerInput = z.infer<typeof createIndexerSchema>;
export type UpdateIndexerInput = z.infer<typeof updateIndexerSchema>;

// Form schema: all possible settings fields optional, superRefine validates per-type
export const createIndexerFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    hostname: z.string().optional(),
    pageLimit: z.number().int().min(1).max(10).optional(),
    apiUrl: z.string().optional(),
    apiKey: z.string().optional(),
  }),
}).superRefine((data, ctx) => {
  if (data.type === 'abb') {
    if (!data.settings.hostname) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'hostname'], message: 'Hostname is required' });
    }
  } else {
    if (!data.settings.apiUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'apiUrl'], message: 'API URL is required' });
    }
    if (!data.settings.apiKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'apiKey'], message: 'API key is required' });
    }
  }
});

export type CreateIndexerFormData = z.infer<typeof createIndexerFormSchema>;
