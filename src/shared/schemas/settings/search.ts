import { z } from 'zod';

export const searchPrioritySchema = z.enum(['quality', 'accuracy']);

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(360),
  enabled: z.boolean().default(true),
  blacklistTtlDays: z.number().int().min(1).max(365).default(7),
  searchPriority: searchPrioritySchema.default('quality'),
});
