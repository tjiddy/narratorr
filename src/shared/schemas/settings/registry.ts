import { z } from 'zod';
import { librarySettingsSchema, libraryFormSchema } from './library.js';
import { searchSettingsSchema } from './search.js';
import { importSettingsSchema } from './import.js';
import { generalSettingsSchema } from './general.js';
import { metadataSettingsSchema } from './metadata.js';
import { processingSettingsSchema } from './processing.js';
import { taggingSettingsSchema } from './tagging.js';
import { qualitySettingsSchema } from './quality.js';
import { networkSettingsSchema } from './network.js';

// ---------------------------------------------------------------------------
// Registry entry helper — enforces defaults match schema at compile time
// ---------------------------------------------------------------------------

function defineCategory<S extends z.ZodObject<z.ZodRawShape>>(entry: {
  schema: S;
  defaults: z.infer<S>;
  formSchema?: z.ZodObject<z.ZodRawShape>;
}) {
  return entry;
}

// ---------------------------------------------------------------------------
// Settings registry — single source of truth for all settings categories
// ---------------------------------------------------------------------------

export const settingsRegistry = {
  library: defineCategory({
    schema: librarySettingsSchema,
    defaults: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    formSchema: libraryFormSchema,
  }),
  search: defineCategory({
    schema: searchSettingsSchema,
    defaults: { intervalMinutes: 360, enabled: true },
  }),
  import: defineCategory({
    schema: importSettingsSchema,
    defaults: { deleteAfterImport: false, minSeedTime: 60 },
  }),
  general: defineCategory({
    schema: generalSettingsSchema,
    defaults: { logLevel: 'info' as const },
  }),
  metadata: defineCategory({
    schema: metadataSettingsSchema,
    defaults: { audibleRegion: 'us' as const },
  }),
  processing: defineCategory({
    schema: processingSettingsSchema,
    defaults: {
      enabled: false,
      ffmpegPath: '',
      outputFormat: 'm4b' as const,
      keepOriginalBitrate: false,
      bitrate: 128,
      mergeBehavior: 'multi-file-only' as const,
    },
  }),
  tagging: defineCategory({
    schema: taggingSettingsSchema,
    defaults: { enabled: false, mode: 'populate_missing' as const, embedCover: false },
  }),
  quality: defineCategory({
    schema: qualitySettingsSchema,
    defaults: {
      grabFloor: 0,
      protocolPreference: 'none' as const,
      minSeeders: 0,
      searchImmediately: false,
      monitorForUpgrades: false,
      rejectWords: '',
      requiredWords: '',
    },
  }),
  network: defineCategory({
    schema: networkSettingsSchema,
    defaults: { proxyUrl: '' },
  }),
};

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

type Registry = typeof settingsRegistry;
export type SettingsCategory = keyof Registry;
export type AppSettings = {
  [K in SettingsCategory]: z.infer<Registry[K]['schema']>;
};
export type UpdateSettingsInput = {
  [K in SettingsCategory]?: Partial<AppSettings[K]>;
};
export type UpdateSettingsFormData = AppSettings;

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

export const SETTINGS_CATEGORIES = Object.keys(settingsRegistry) as SettingsCategory[];

export const DEFAULT_SETTINGS: AppSettings = Object.fromEntries(
  SETTINGS_CATEGORIES.map((key) => [key, settingsRegistry[key].defaults]),
) as AppSettings;

export const CATEGORY_SCHEMAS = Object.fromEntries(
  SETTINGS_CATEGORIES.map((key) => [key, settingsRegistry[key].schema]),
) as { [K in SettingsCategory]: Registry[K]['schema'] };

// ---------------------------------------------------------------------------
// Form schema derivation
// ---------------------------------------------------------------------------

function stripDefaults(schema: z.ZodObject<z.ZodRawShape>) {
  const newShape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    // Zod v4: shape entries are $ZodType (internal), cast for public ZodType compat
    newShape[key] = (field instanceof z.ZodDefault ? field.removeDefault() : field) as never;
  }
  return z.object(newShape);
}

function getFormSchema(entry: { schema: z.ZodObject<z.ZodRawShape>; formSchema?: z.ZodObject<z.ZodRawShape> }) {
  return entry.formSchema ?? stripDefaults(entry.schema);
}

// ---------------------------------------------------------------------------
// Composed schemas — dynamically built, typed via assertions
// ---------------------------------------------------------------------------

export const appSettingsSchema = z.object(
  Object.fromEntries(
    SETTINGS_CATEGORIES.map((key) => [key, settingsRegistry[key].schema]),
  ),
) as unknown as z.ZodType<AppSettings>;

export const updateSettingsSchema = z.object(
  Object.fromEntries(
    SETTINGS_CATEGORIES.map((key) => [key, settingsRegistry[key].schema.partial().optional()]),
  ),
).superRefine((data: Record<string, unknown>, ctx) => {
  const processing = data.processing as { enabled?: boolean; ffmpegPath?: string } | undefined;
  if (processing?.enabled && !processing.ffmpegPath?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processing', 'ffmpegPath'],
      message: 'ffmpeg path is required when processing is enabled',
    });
  }
}) as unknown as z.ZodType<UpdateSettingsInput>;

const _formSchemaBase = z.object(
  Object.fromEntries(
    SETTINGS_CATEGORIES.map((key) => [key, getFormSchema(settingsRegistry[key])]),
  ),
).superRefine((data: Record<string, unknown>, ctx) => {
  const processing = data.processing as { enabled: boolean; ffmpegPath: string };
  if (processing.enabled && !processing.ffmpegPath.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['processing', 'ffmpegPath'],
      message: 'ffmpeg not found at specified path',
    });
  }
});
export const updateSettingsFormSchema: z.ZodType<UpdateSettingsFormData, UpdateSettingsFormData> = _formSchemaBase as never;

// ---------------------------------------------------------------------------
// Utility: convert API settings response to form data with fallback defaults
// ---------------------------------------------------------------------------

export function settingsToFormData(settings: AppSettings): UpdateSettingsFormData {
  return Object.fromEntries(
    SETTINGS_CATEGORIES.map((key) => [
      key,
      { ...DEFAULT_SETTINGS[key], ...settings[key] },
    ]),
  ) as UpdateSettingsFormData;
}
