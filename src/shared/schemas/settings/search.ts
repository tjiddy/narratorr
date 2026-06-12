import { z } from 'zod';
import { protocolPreferenceSchema } from './quality.js';

export const searchPrioritySchema = z.enum(['quality', 'accuracy']);

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(360),
  enabled: z.boolean().default(true),
  blacklistTtlDays: z.number().int().min(1).max(365).default(7),
  searchPriority: searchPrioritySchema.default('accuracy'),
});

// Page form schema for SearchSettingsSection — a cross-category UI merge of the
// `search` category plus `quality.protocolPreference` and the `rss` category,
// with renamed keys (searchEnabled/rssEnabled, searchIntervalMinutes/rssIntervalMinutes)
// to disambiguate the two enabled/interval pairs surfaced on one page. Relocated
// from the page module (was a local const) so registry.test.ts can guard it
// against silent category-field drift (#1388, #1350). The z.object shape — and
// thus form behavior — is unchanged; this is NOT a refactor onto the registered
// category schemas via .extend().
export const searchFormSchema = z.object({
  searchEnabled: z.boolean(),
  searchIntervalMinutes: z.number().int().min(5).max(1440),
  searchPriority: searchPrioritySchema,
  protocolPreference: protocolPreferenceSchema,
  blacklistTtlDays: z.number().int().min(1).max(365),
  rssEnabled: z.boolean(),
  rssIntervalMinutes: z.number().int().min(5).max(1440),
});
