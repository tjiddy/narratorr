import { z } from 'zod';

export const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug', 'trace']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const generalSettingsSchema = z.object({
  logLevel: logLevelSchema.default('info'),
  housekeepingRetentionDays: z.number().int().min(1).max(365).default(90),
  recycleRetentionDays: z.number().int().min(0).max(365).default(30),
  welcomeSeen: z.boolean().default(false),
});

// Form schema excludes welcomeSeen — it's managed by Layout.tsx for onboarding,
// not by the General settings form. Including it would overwrite onboarding state.
// Derived via .pick().omit() to reuse validators from the settings schema shape.
export const generalFormSchema = z.object({
  logLevel: logLevelSchema,
  housekeepingRetentionDays: z.number().int().min(1).max(365),
  recycleRetentionDays: z.number().int().min(0).max(365),
});
