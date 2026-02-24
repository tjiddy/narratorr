/* eslint-disable max-lines */
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
// Remote Path Mapping schemas
// ============================================================================

export const createRemotePathMappingSchema = z.object({
  downloadClientId: z.number().int().positive('Download client is required'),
  remotePath: z.string().min(1, 'Remote path is required').max(500),
  localPath: z.string().min(1, 'Local path is required').max(500),
});

export const updateRemotePathMappingSchema = z.object({
  downloadClientId: z.number().int().positive().optional(),
  remotePath: z.string().min(1).max(500).optional(),
  localPath: z.string().min(1).max(500).optional(),
});

export type CreateRemotePathMappingInput = z.infer<typeof createRemotePathMappingSchema>;
export type UpdateRemotePathMappingInput = z.infer<typeof updateRemotePathMappingSchema>;

// ============================================================================
// Search schemas
// ============================================================================

export const searchQuerySchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters').max(500),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  author: z.string().max(200).optional(),
  title: z.string().max(500).optional(),
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

const FOLDER_FORMAT_ALLOWED_TOKENS = [
  'author', 'authorLastFirst',
  'title', 'titleSort',
  'series', 'seriesPosition',
  'year',
  'narrator', 'narratorLastFirst',
];

const FILE_FORMAT_ALLOWED_TOKENS = [
  ...FOLDER_FORMAT_ALLOWED_TOKENS,
  'trackNumber', 'trackTotal', 'partName',
];

export const folderFormatSchema = z.string().default('{author}/{title}').refine(
  (val) => /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val),
  { message: 'Template must include {title} or {titleSort}' },
).refine(
  (val) => {
    const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(val)) !== null) {
      if (!FOLDER_FORMAT_ALLOWED_TOKENS.includes(match[1])) return false;
    }
    return true;
  },
  { message: 'Unknown token in template. Allowed: {author}, {authorLastFirst}, {title}, {titleSort}, {series}, {seriesPosition}, {year}, {narrator}, {narratorLastFirst}' },
);

export const fileFormatSchema = z.string().default('{author} - {title}').refine(
  (val) => /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val),
  { message: 'Template must include {title} or {titleSort}' },
).refine(
  (val) => {
    const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(val)) !== null) {
      if (!FILE_FORMAT_ALLOWED_TOKENS.includes(match[1])) return false;
    }
    return true;
  },
  { message: 'Unknown token in template. Allowed: {author}, {title}, {trackNumber}, {trackTotal}, {partName}, and more' },
);

export const librarySettingsSchema = z.object({
  path: z.string().min(1, 'Library path is required'),
  folderFormat: folderFormatSchema,
  fileFormat: fileFormatSchema,
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

export const outputFormatSchema = z.enum(['m4b', 'mp3']);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const mergeBehaviorSchema = z.enum(['always', 'multi-file-only', 'never']);
export type MergeBehavior = z.infer<typeof mergeBehaviorSchema>;

export const processingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  ffmpegPath: z.string().default(''),
  outputFormat: outputFormatSchema.default('m4b'),
  keepOriginalBitrate: z.boolean().default(false),
  bitrate: z.number().int().min(32).max(512).default(128),
  mergeBehavior: mergeBehaviorSchema.default('multi-file-only'),
});

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const generalSettingsSchema = z.object({
  logLevel: logLevelSchema.default('info'),
});

export const audibleRegionSchema = z.enum(['us', 'ca', 'uk', 'au', 'fr', 'de', 'jp', 'it', 'in', 'es']);
export type AudibleRegion = z.infer<typeof audibleRegionSchema>;

export const metadataSettingsSchema = z.object({
  audibleRegion: audibleRegionSchema.default('us'),
});

export const appSettingsSchema = z.object({
  library: librarySettingsSchema,
  search: searchSettingsSchema,
  import: importSettingsSchema,
  general: generalSettingsSchema,
  metadata: metadataSettingsSchema,
  processing: processingSettingsSchema,
});

export const updateSettingsSchema = z.object({
  library: librarySettingsSchema.partial().optional(),
  search: searchSettingsSchema.partial().optional(),
  import: importSettingsSchema.partial().optional(),
  general: generalSettingsSchema.partial().optional(),
  metadata: metadataSettingsSchema.partial().optional(),
  processing: processingSettingsSchema.partial().optional(),
}).superRefine((data, ctx) => {
  if (data.processing?.enabled && !data.processing.ffmpegPath?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processing', 'ffmpegPath'],
      message: 'ffmpeg path is required when processing is enabled',
    });
  }
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// Form schema for client-side settings form (all fields required)
export const updateSettingsFormSchema = z.object({
  library: z.object({
    path: z.string().min(1, 'Library path is required'),
    folderFormat: z.string().min(1, 'Folder format is required').refine(
      (val) => /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val),
      { message: 'Template must include {title} or {titleSort}' },
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
    fileFormat: z.string().min(1, 'File format is required').refine(
      (val) => /\{title(?:Sort)?(?::\d+)?(?:\?[^}]*)?\}/.test(val),
      { message: 'Template must include {title} or {titleSort}' },
    ).refine(
      (val) => {
        const tokenPattern = /\{(\w+)(?::\d+)?(?:\?[^}]*)?\}/g;
        let match: RegExpExecArray | null;
        while ((match = tokenPattern.exec(val)) !== null) {
          if (!FILE_FORMAT_ALLOWED_TOKENS.includes(match[1])) return false;
        }
        return true;
      },
      { message: 'Unknown token in file template' },
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
  metadata: z.object({
    audibleRegion: audibleRegionSchema,
  }),
  processing: z.object({
    enabled: z.boolean(),
    ffmpegPath: z.string(),
    outputFormat: outputFormatSchema,
    keepOriginalBitrate: z.boolean(),
    bitrate: z.number().int().min(32).max(512),
    mergeBehavior: mergeBehaviorSchema,
  }),
}).superRefine((data, ctx) => {
  if (data.processing.enabled && !data.processing.ffmpegPath.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processing', 'ffmpegPath'],
      message: 'ffmpeg not found at specified path',
    });
  }
});

export type UpdateSettingsFormData = z.infer<typeof updateSettingsFormSchema>;

// ============================================================================
// Auth schemas
// ============================================================================

export const authModeSchema = z.enum(['none', 'basic', 'forms']);
export type AuthMode = z.infer<typeof authModeSchema>;

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const setupCredentialsSchema = z.object({
  username: z.string().min(1, 'Username is required').max(50),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export type SetupCredentialsInput = z.infer<typeof setupCredentialsSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateAuthConfigSchema = z.object({
  mode: authModeSchema.optional(),
  localBypass: z.boolean().optional(),
});

export type UpdateAuthConfigInput = z.infer<typeof updateAuthConfigSchema>;

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

export const providerIdParamSchema = z.object({
  id: z.string().min(1, 'Provider ID is required'),
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

// ============================================================================
// Blacklist schemas
// ============================================================================

export const blacklistReasonSchema = z.enum(['wrong_content', 'bad_quality', 'wrong_narrator', 'spam', 'other']);

export const createBlacklistSchema = z.object({
  infoHash: z.string().min(1, 'Info hash is required'),
  title: z.string().min(1, 'Title is required'),
  bookId: z.number().int().optional(),
  reason: blacklistReasonSchema.optional(),
  note: z.string().max(500).optional(),
});

export type CreateBlacklistInput = z.infer<typeof createBlacklistSchema>;

// ============================================================================
// Prowlarr schemas
// ============================================================================

export const prowlarrSyncModeSchema = z.enum(['addOnly', 'fullSync']);

export const prowlarrConfigSchema = z.object({
  url: z.string().min(1, 'Prowlarr URL is required').url('Must be a valid URL'),
  apiKey: z.string().min(1, 'API key is required'),
  syncMode: prowlarrSyncModeSchema.default('addOnly'),
  categories: z.array(z.number().int()).default([3030]),
});

export type ProwlarrConfigInput = z.infer<typeof prowlarrConfigSchema>;

export const prowlarrTestSchema = z.object({
  url: z.string().min(1, 'Prowlarr URL is required'),
  apiKey: z.string().min(1, 'API key is required'),
});

export const prowlarrSyncApplySchema = z.object({
  items: z.array(z.object({
    prowlarrId: z.number().int(),
    action: z.enum(['new', 'updated', 'unchanged', 'removed']),
    selected: z.boolean(),
  })),
});

export type ProwlarrSyncApplyInput = z.infer<typeof prowlarrSyncApplySchema>;
