// Barrel re-export — all category schemas, registry, and derived types
export { folderFormatSchema, fileFormatSchema, librarySettingsSchema, FOLDER_FORMAT_ALLOWED_TOKENS, FILE_FORMAT_ALLOWED_TOKENS } from './library.js';
export { searchSettingsSchema } from './search.js';
export { importSettingsSchema } from './import.js';
export { logLevelSchema, type LogLevel, generalSettingsSchema } from './general.js';
export { audibleRegionSchema, type AudibleRegion, metadataSettingsSchema } from './metadata.js';
export { outputFormatSchema, type OutputFormat, mergeBehaviorSchema, type MergeBehavior, processingSettingsSchema } from './processing.js';
export { tagModeSchema, type TagMode, taggingSettingsSchema } from './tagging.js';
export { protocolPreferenceSchema, type ProtocolPreference, qualitySettingsSchema } from './quality.js';
export {
  settingsRegistry,
  type SettingsCategory,
  type AppSettings,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
  appSettingsSchema,
  updateSettingsSchema,
  updateSettingsFormSchema,
  type UpdateSettingsInput,
  type UpdateSettingsFormData,
  settingsToFormData,
} from './registry.js';
