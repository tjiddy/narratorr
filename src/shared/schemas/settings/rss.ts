import { z } from 'zod';

export const rssSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(30),
  enabled: z.boolean().default(false),
});
