import { z } from 'zod';
import { protocolPreferenceSchema } from './quality.js';

export const searchPrioritySchema = z.enum(['quality', 'accuracy']);

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(360),
  enabled: z.boolean().default(true),
  blacklistTtlDays: z.number().int().min(1).max(365).default(7),
  searchPriority: searchPrioritySchema.default('accuracy'),
});

// Page-only merge of search, protocol preference, and RSS; renamed fields disambiguate duplicates.
export const searchFormSchema = z.object({
  searchEnabled: z.boolean(),
  searchIntervalMinutes: z.number().int().min(5).max(1440),
  searchPriority: searchPrioritySchema,
  protocolPreference: protocolPreferenceSchema,
  blacklistTtlDays: z.number().int().min(1).max(365),
  rssEnabled: z.boolean(),
  rssIntervalMinutes: z.number().int().min(5).max(1440),
});
