import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

export const protocolPreferenceSchema = z.enum(['usenet', 'torrent', 'none']);
export type ProtocolPreference = z.infer<typeof protocolPreferenceSchema>;

export const DEFAULT_REJECT_WORDS = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged';

export const qualitySettingsSchema = z.object({
  grabFloor: z.number().nonnegative().default(0),
  protocolPreference: protocolPreferenceSchema.default('none'),
  minSeeders: z.number().int().nonnegative().default(1),
  // 50 MB filters tracker-test uploads / single-track previews out of the box; 0 disables.
  minDownloadSize: z.number().nonnegative().default(50),
  maxDownloadSize: z.number().nonnegative().default(5),
  searchImmediately: z.boolean().default(false),
  rejectWords: z.string().default(DEFAULT_REJECT_WORDS),
  requiredWords: z.string().default(''),
});

export const qualityFormSchema = stripDefaults(qualitySettingsSchema) as z.ZodObject<{
  grabFloor: z.ZodNumber;
  protocolPreference: typeof protocolPreferenceSchema;
  minSeeders: z.ZodNumber;
  minDownloadSize: z.ZodNumber;
  maxDownloadSize: z.ZodNumber;
  searchImmediately: z.ZodBoolean;
  rejectWords: z.ZodString;
  requiredWords: z.ZodString;
}>;

export const qualityFilteringFormSchema = qualityFormSchema.omit({ searchImmediately: true });

export const newBookDefaultsFormSchema = qualityFormSchema.pick({ searchImmediately: true });
