import { z } from 'zod';

export const tagModeSchema = z.enum(['populate_missing', 'overwrite']);
export type TagMode = z.infer<typeof tagModeSchema>;

export const taggingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: tagModeSchema.default('populate_missing'),
  embedCover: z.boolean().default(false),
});
