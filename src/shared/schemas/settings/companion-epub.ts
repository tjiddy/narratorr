import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

export const companionEpubSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

export const companionEpubFormSchema = stripDefaults(companionEpubSettingsSchema).pick({
  enabled: true,
}) as z.ZodObject<{
  enabled: z.ZodBoolean;
}>;
