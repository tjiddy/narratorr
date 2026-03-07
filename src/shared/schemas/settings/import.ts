import { z } from 'zod';

export const importSettingsSchema = z.object({
  deleteAfterImport: z.boolean().default(false),
  minSeedTime: z.number().int().min(0).default(0),
});
