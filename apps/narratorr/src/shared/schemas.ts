import { z } from 'zod';

// ============================================================================
// Common schemas
// ============================================================================

export const idParamSchema = z.object({
  id: z.string().transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ID',
      });
      return z.NEVER;
    }
    return parsed;
  }),
});

// ============================================================================
// Indexer schemas
// ============================================================================

export const indexerTypeSchema = z.enum(['abb', 'torznab']);

export const indexerSettingsSchema = z.object({
  hostname: z.string().min(1, 'Hostname is required'),
  pageLimit: z.number().int().min(1).max(10).default(2),
});

export const createIndexerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: indexerSettingsSchema,
});

export const updateIndexerSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: indexerSettingsSchema.partial().optional(),
});

// Output types (after Zod applies defaults)
export type CreateIndexerInput = z.infer<typeof createIndexerSchema>;
export type UpdateIndexerInput = z.infer<typeof updateIndexerSchema>;

// Form schemas for client-side validation (all fields required, no defaults)
export const createIndexerFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: indexerTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    hostname: z.string().min(1, 'Hostname is required'),
    pageLimit: z.number().int().min(1).max(10),
  }),
});

export type CreateIndexerFormData = z.infer<typeof createIndexerFormSchema>;

// ============================================================================
// Download Client schemas
// ============================================================================

export const downloadClientTypeSchema = z.enum(['qbittorrent', 'transmission', 'sabnzbd']);

export const qbittorrentSettingsSchema = z.object({
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).default(8080),
  username: z.string().default(''),
  password: z.string().default(''),
  useSsl: z.boolean().default(false),
});

export const createDownloadClientSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: qbittorrentSettingsSchema,
});

export const updateDownloadClientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: qbittorrentSettingsSchema.partial().optional(),
});

// Output types (after Zod applies defaults)
export type CreateDownloadClientInput = z.infer<typeof createDownloadClientSchema>;
export type UpdateDownloadClientInput = z.infer<typeof updateDownloadClientSchema>;

// Form schemas for client-side validation (all fields required, no defaults)
export const createDownloadClientFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    host: z.string().min(1, 'Host is required'),
    port: z.number().int().min(1).max(65535),
    username: z.string(),
    password: z.string(),
    useSsl: z.boolean(),
  }),
});

export type CreateDownloadClientFormData = z.infer<typeof createDownloadClientFormSchema>;

// ============================================================================
// Search schemas
// ============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters'),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
});

export const grabSchema = z.object({
  magnetUri: z.string().min(1, 'Magnet URI is required').startsWith('magnet:', 'Invalid magnet URI'),
  title: z.string().min(1, 'Title is required'),
  bookId: z.number().int().positive().optional(),
  indexerId: z.number().int().positive().optional(),
  size: z.number().int().nonnegative().optional(),
  seeders: z.number().int().nonnegative().optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type GrabInput = z.infer<typeof grabSchema>;

// ============================================================================
// Settings schemas
// ============================================================================

export const librarySettingsSchema = z.object({
  path: z.string().min(1, 'Library path is required'),
  folderFormat: z.string().default('{author}/{title}'),
});

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
  enabled: z.boolean().default(false),
});

export const importSettingsSchema = z.object({
  deleteAfterImport: z.boolean().default(false),
  minSeedTime: z.number().int().min(0).default(0),
});

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const generalSettingsSchema = z.object({
  logLevel: logLevelSchema.default('info'),
});

export const appSettingsSchema = z.object({
  library: librarySettingsSchema,
  search: searchSettingsSchema,
  import: importSettingsSchema,
  general: generalSettingsSchema,
});

export const updateSettingsSchema = z.object({
  library: librarySettingsSchema.partial().optional(),
  search: searchSettingsSchema.partial().optional(),
  import: importSettingsSchema.partial().optional(),
  general: generalSettingsSchema.partial().optional(),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// Form schema for client-side settings form (all fields required)
export const updateSettingsFormSchema = z.object({
  library: z.object({
    path: z.string().min(1, 'Library path is required'),
    folderFormat: z.string().min(1, 'Folder format is required'),
  }),
  general: z.object({
    logLevel: logLevelSchema,
  }),
});

export type UpdateSettingsFormData = z.infer<typeof updateSettingsFormSchema>;

// ============================================================================
// Metadata schemas
// ============================================================================

export const metadataSearchQuerySchema = z.object({
  q: z.string().min(1, 'Query is required'),
});

export const asinParamSchema = z.object({
  asin: z.string().min(1, 'ASIN is required'),
});

export type MetadataSearchQuery = z.infer<typeof metadataSearchQuerySchema>;

// ============================================================================
// Activity schemas
// ============================================================================

export const downloadStatusSchema = z.enum([
  'queued',
  'downloading',
  'paused',
  'completed',
  'importing',
  'imported',
  'failed',
]);

export type DownloadStatus = z.infer<typeof downloadStatusSchema>;
