import { z } from 'zod';
import { CANONICAL_LANGUAGES } from '../../language-constants.js';

export const audibleRegionSchema = z.enum(['us', 'ca', 'uk', 'au', 'fr', 'de', 'jp', 'it', 'in', 'es']);
export type AudibleRegion = z.infer<typeof audibleRegionSchema>;

export const metadataSettingsSchema = z.object({
  audibleRegion: audibleRegionSchema.default('us'),
  languages: z.array(z.enum(CANONICAL_LANGUAGES)).default(['english']),
  minDurationMinutes: z.number().int().nonnegative().default(0),
  hardcoverApiKey: z.string().default(''),
});

// Page form schema for MetadataSettingsSection. Intentionally surfaces only
// `audibleRegion` and `hardcoverApiKey` — the category's `languages` and
// `minDurationMinutes` are edited on the Filtering page (see filteringFormSchema
// below), not here. Do NOT "restore" those two fields to this form: they would
// then be double-edited across two pages. This intentional omission is recorded
// in registry.test.ts's METADATA_OMISSION_ALLOWLIST so the drift guard accepts
// it today but fails if a *new, undocumented* metadata field is later dropped.
// Relocated from the page module so the test can guard it (#1388). Shape unchanged.
export const metadataFormSchema = z.object({
  audibleRegion: audibleRegionSchema,
  hardcoverApiKey: z.string(),
});

// Page form schema for FilteringSettingsSection — a cross-category UI merge of
// `metadata.languages` + `metadata.minDurationMinutes` with `quality.rejectWords`
// + `quality.requiredWords`. There is no `filtering` category (Filtering is a
// UI-only page); the schema is homed here on its metadata root. Relocated from
// the page module so registry.test.ts can guard it (#1388). Shape unchanged — this
// is NOT a refactor onto registered category schemas via .extend().
export const filteringFormSchema = z.object({
  languages: z.array(z.string()),
  minDurationMinutes: z.number().int().nonnegative(),
  rejectWords: z.string(),
  requiredWords: z.string(),
});
