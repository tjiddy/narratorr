import { z } from 'zod';

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const generalSettingsSchema = z.object({
  logLevel: logLevelSchema.default('info'),
  housekeepingRetentionDays: z.number().int().min(1).max(365).default(90),
  recycleRetentionDays: z.number().int().min(0).max(365).default(30),
  welcomeSeen: z.boolean().default(false),
});
