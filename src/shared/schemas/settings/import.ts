import { z } from 'zod';

export const importSettingsSchema = z.object({
  deleteAfterImport: z.boolean().default(false),
  minSeedTime: z.number().int().min(0).default(60),
  minSeedRatio: z.number().min(0).default(0),
  minFreeSpaceGB: z.number().min(0).default(5),
  redownloadFailed: z.boolean().default(true),
});
