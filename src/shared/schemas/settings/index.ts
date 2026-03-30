// Barrel re-export — all category schemas, registry, and derived types
export { folderFormatSchema, fileFormatSchema, librarySettingsSchema, libraryFormSchema, namingFormSchema, FOLDER_FORMAT_ALLOWED_TOKENS, FILE_FORMAT_ALLOWED_TOKENS, namingSeparatorValues, namingSeparatorSchema, namingCaseValues, namingCaseSchema, type NamingSeparator, type NamingCase, hasTitle, hasAuthor, validateTokens, FOLDER_TITLE_MSG, FOLDER_TOKEN_MSG, FILE_TITLE_MSG, FILE_TOKEN_MSG } from './library.js';
export { searchSettingsSchema } from './search.js';
export { importSettingsSchema } from './import.js';
export { logLevelSchema, type LogLevel, generalSettingsSchema } from './general.js';
export { audibleRegionSchema, type AudibleRegion, metadataSettingsSchema } from './metadata.js';
export { outputFormatSchema, type OutputFormat, mergeBehaviorSchema, type MergeBehavior, processingSettingsSchema } from './processing.js';
export { tagModeSchema, type TagMode, taggingSettingsSchema } from './tagging.js';
export { protocolPreferenceSchema, type ProtocolPreference, qualitySettingsSchema } from './quality.js';
export { networkSettingsSchema } from './network.js';
export { discoverySettingsSchema } from './discovery.js';
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
  stripDefaults,
} from './registry.js';
