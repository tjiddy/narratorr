import { z } from 'zod';
import { stripDefaults } from './strip-defaults.js';

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const generalSettingsSchema = z.object({
  logLevel: logLevelSchema.default('info'),
  housekeepingRetentionDays: z.number().int().min(1).max(365).default(90),
  welcomeSeen: z.boolean().default(false),
});

// `welcomeSeen` is Layout-owned onboarding state; submitting it here could overwrite it.
export const generalFormSchema = stripDefaults(generalSettingsSchema).pick({
  logLevel: true,
  housekeepingRetentionDays: true,
}) as z.ZodObject<{
  logLevel: typeof logLevelSchema;
  housekeepingRetentionDays: z.ZodNumber;
}>;
