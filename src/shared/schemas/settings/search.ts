import { z } from 'zod';

export const searchSettingsSchema = z.object({
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
  enabled: z.boolean().default(false),
});
