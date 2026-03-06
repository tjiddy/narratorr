import { z } from 'zod';

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

export const tagModeSchema = z.enum(['populate_missing', 'overwrite']);
export type TagMode = z.infer<typeof tagModeSchema>;

export const taggingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: tagModeSchema.default('populate_missing'),
  embedCover: z.boolean().default(false),
});

export const protocolPreferenceSchema = z.enum(['usenet', 'torrent', 'none']);
export type ProtocolPreference = z.infer<typeof protocolPreferenceSchema>;

export const qualitySettingsSchema = z.object({
  grabFloor: z.number().nonnegative().default(0),
  protocolPreference: protocolPreferenceSchema.default('none'),
  minSeeders: z.number().int().nonnegative().default(0),
  searchImmediately: z.boolean().default(false),
  monitorForUpgrades: z.boolean().default(false),
});

export const appSettingsSchema = z.object({
  library: librarySettingsSchema,
  search: searchSettingsSchema,
  import: importSettingsSchema,
  general: generalSettingsSchema,
  metadata: metadataSettingsSchema,
  processing: processingSettingsSchema,
  tagging: taggingSettingsSchema,
  quality: qualitySettingsSchema,
});

export const updateSettingsSchema = z.object({
  library: librarySettingsSchema.partial().optional(),
  search: searchSettingsSchema.partial().optional(),
  import: importSettingsSchema.partial().optional(),
  general: generalSettingsSchema.partial().optional(),
  metadata: metadataSettingsSchema.partial().optional(),
  processing: processingSettingsSchema.partial().optional(),
  tagging: taggingSettingsSchema.partial().optional(),
  quality: qualitySettingsSchema.partial().optional(),
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
  tagging: z.object({
    enabled: z.boolean(),
    mode: tagModeSchema,
    embedCover: z.boolean(),
  }),
  quality: z.object({
    grabFloor: z.number().nonnegative(),
    protocolPreference: protocolPreferenceSchema,
    minSeeders: z.number().int().nonnegative(),
    searchImmediately: z.boolean(),
    monitorForUpgrades: z.boolean(),
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
