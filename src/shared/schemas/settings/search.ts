import { z } from 'zod';

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(360),
  enabled: z.boolean().default(true),
  blacklistTtlDays: z.number().int().min(1).max(365).default(7),
});
