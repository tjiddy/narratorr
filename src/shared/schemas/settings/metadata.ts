import { z } from 'zod';
import { CANONICAL_LANGUAGES } from '../../language-constants.js';

export const audibleRegionSchema = z.enum(['us', 'ca', 'uk', 'au', 'fr', 'de', 'jp', 'it', 'in', 'es']);
export type AudibleRegion = z.infer<typeof audibleRegionSchema>;

export const metadataSettingsSchema = z.object({
  audibleRegion: audibleRegionSchema.default('us'),
  languages: z.array(z.enum(CANONICAL_LANGUAGES)).default(['english']),
  minDurationMinutes: z.number().int().nonnegative().default(30),
  hardcoverApiKey: z.string().default(''),
});

// Filtering owns languages and minDurationMinutes; exposing them here would make two pages edit them.
export const metadataFormSchema = z.object({
  audibleRegion: audibleRegionSchema,
  hardcoverApiKey: z.string(),
});

// Filtering is a UI-only merge of metadata and quality fields, not a settings category.
export const filteringFormSchema = z.object({
  languages: z.array(z.string()),
  minDurationMinutes: z.number().int().nonnegative(),
  rejectWords: z.string(),
  requiredWords: z.string(),
});
