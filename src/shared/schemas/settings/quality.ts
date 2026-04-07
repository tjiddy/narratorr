import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

export const protocolPreferenceSchema = z.enum(['usenet', 'torrent', 'none']);
export type ProtocolPreference = z.infer<typeof protocolPreferenceSchema>;

export const qualitySettingsSchema = z.object({
  grabFloor: z.number().nonnegative().default(0),
  protocolPreference: protocolPreferenceSchema.default('none'),
  minSeeders: z.number().int().nonnegative().default(1),
  searchImmediately: z.boolean().default(false),
  monitorForUpgrades: z.boolean().default(false),
  rejectWords: z.string().default(''),
  requiredWords: z.string().default(''),
});

// Form schema derived from qualitySettingsSchema via stripDefaults() — strips
// .default() wrappers so all fields require explicit values in the form.
// Cast to typed ZodObject for zodResolver/z.infer compatibility (Zod v4 limitation:
// stripDefaults returns untyped shape; runtime behavior is correct).
export const qualityFormSchema = stripDefaults(qualitySettingsSchema) as z.ZodObject<{
  grabFloor: z.ZodNumber;
  protocolPreference: typeof protocolPreferenceSchema;
  minSeeders: z.ZodNumber;
  searchImmediately: z.ZodBoolean;
  monitorForUpgrades: z.ZodBoolean;
  rejectWords: z.ZodString;
  requiredWords: z.ZodString;
}>;

/** Quality-filtering fields only (excludes new-book defaults) — used by QualitySettingsSection form */
export const qualityFilteringFormSchema = qualityFormSchema.omit({ searchImmediately: true, monitorForUpgrades: true });

/** New-book default fields only — used by LibrarySettingsSection "When a New Book Is Added" form */
export const newBookDefaultsFormSchema = qualityFormSchema.pick({ searchImmediately: true, monitorForUpgrades: true });
