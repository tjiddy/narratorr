import { z } from 'zod';
import { CANONICAL_LANGUAGES } from '../../language-constants.js';

export const audibleRegionSchema = z.enum(['us', 'ca', 'uk', 'au', 'fr', 'de', 'jp', 'it', 'in', 'es']);
export type AudibleRegion = z.infer<typeof audibleRegionSchema>;

export const metadataSettingsSchema = z.object({
  audibleRegion: audibleRegionSchema.default('us'),
  languages: z.array(z.enum(CANONICAL_LANGUAGES)).default(['english']),
});
