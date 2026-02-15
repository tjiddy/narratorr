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

// ============================================================================
// Download Client schemas
// ============================================================================

export const downloadClientTypeSchema = z.enum(['qbittorrent', 'transmission', 'sabnzbd', 'nzbget']);

// Server-side: accepts any settings shape (type-specific validation is client-side only)
export const createDownloadClientSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  settings: z.record(z.string(), z.unknown()),
});

export const updateDownloadClientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Output types (after Zod applies defaults)
export type CreateDownloadClientInput = z.infer<typeof createDownloadClientSchema>;
export type UpdateDownloadClientInput = z.infer<typeof updateDownloadClientSchema>;

// Form schema: all possible settings fields optional, superRefine validates per-type
export const createDownloadClientFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: downloadClientTypeSchema,
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  settings: z.object({
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    useSsl: z.boolean().optional(),
    apiKey: z.string().optional(),
  }),
}).superRefine((data, ctx) => {
  if (!data.settings.host) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'host'], message: 'Host is required' });
  }
  if (!data.settings.port) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'port'], message: 'Port is required' });
  }
  if (data.type === 'sabnzbd') {
    if (!data.settings.apiKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'apiKey'], message: 'API key is required' });
    }
  }
});

export type CreateDownloadClientFormData = z.infer<typeof createDownloadClientFormSchema>;

// ============================================================================
// Search schemas
// ============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters').max(500),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
});

export const grabSchema = z.object({
  downloadUrl: z.string().min(1, 'Download URL is required'),
  title: z.string().min(1, 'Title is required'),
  protocol: z.enum(['torrent', 'usenet']).default('torrent'),
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

const FOLDER_FORMAT_ALLOWED_TOKENS = ['author', 'title', 'series', 'seriesPosition', 'year', 'narrator'];

export const folderFormatSchema = z.string().default('{author}/{title}').refine(
  (val) => /\{title(?::\d+)?(?:\?[^}]*)?\}/.test(val),
  { message: 'Template must include {title}' },
).refine(
  (val) => {
    const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(val)) !== null) {
      if (!FOLDER_FORMAT_ALLOWED_TOKENS.includes(match[1])) return false;
    }
    return true;
  },
  { message: 'Unknown token in template. Allowed: {author}, {title}, {series}, {seriesPosition}, {year}, {narrator}' },
);

export const librarySettingsSchema = z.object({
  path: z.string().min(1, 'Library path is required'),
  folderFormat: folderFormatSchema,
});

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
  enabled: z.boolean().default(false),
  autoGrab: z.boolean().default(false),
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
    folderFormat: z.string().min(1, 'Folder format is required').refine(
      (val) => /\{title(?::\d+)?(?:\?[^}]*)?\}/.test(val),
      { message: 'Template must include {title}' },
    ).refine(
      (val) => {
        const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
        let match: RegExpExecArray | null;
        while ((match = tokenPattern.exec(val)) !== null) {
          if (!FOLDER_FORMAT_ALLOWED_TOKENS.includes(match[1])) return false;
        }
        return true;
      },
      { message: 'Unknown token in template' },
    ),
  }),
  search: z.object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(5).max(1440),
    autoGrab: z.boolean(),
  }),
  import: z.object({
    deleteAfterImport: z.boolean(),
    minSeedTime: z.number().int().min(0),
  }),
  general: z.object({
    logLevel: logLevelSchema,
  }),
});

export type UpdateSettingsFormData = z.infer<typeof updateSettingsFormSchema>;

// ============================================================================
// Notifier schemas
// ============================================================================

export const notifierTypeSchema = z.enum(['webhook', 'discord', 'script']);
export const notificationEventSchema = z.enum(['on_grab', 'on_download_complete', 'on_import', 'on_failure']);

export const createNotifierSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean().default(true),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.record(z.string(), z.unknown()),
});

export const updateNotifierSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  events: z.array(notificationEventSchema).min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type CreateNotifierInput = z.infer<typeof createNotifierSchema>;
export type UpdateNotifierInput = z.infer<typeof updateNotifierSchema>;

export const createNotifierFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean(),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.object({
    url: z.string().optional(),
    method: z.enum(['POST', 'PUT']).optional(),
    headers: z.string().optional(),
    bodyTemplate: z.string().optional(),
    webhookUrl: z.string().optional(),
    includeCover: z.boolean().optional(),
    path: z.string().optional(),
    timeout: z.number().int().min(1).max(300).optional(),
  }),
}).superRefine((data, ctx) => {
  if (data.type === 'webhook') {
    if (!data.settings.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'url'], message: 'URL is required' });
    }
  } else if (data.type === 'discord') {
    if (!data.settings.webhookUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'webhookUrl'], message: 'Webhook URL is required' });
    }
  } else if (data.type === 'script') {
    if (!data.settings.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'path'], message: 'Script path is required' });
    }
  }
});

export type CreateNotifierFormData = z.infer<typeof createNotifierFormSchema>;

// ============================================================================
// Metadata schemas
// ============================================================================

export const metadataSearchQuerySchema = z.object({
  q: z.string().min(1, 'Query is required').max(500),
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
