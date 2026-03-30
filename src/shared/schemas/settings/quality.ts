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

export const qualityFormSchema = stripDefaults(qualitySettingsSchema);
