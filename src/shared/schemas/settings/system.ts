import { z } from 'zod';

export const systemSettingsSchema = z.object({
  backupIntervalMinutes: z.number().int().min(60).max(43200).default(10080),
  backupRetention: z.number().int().min(1).max(100).default(7),
});
