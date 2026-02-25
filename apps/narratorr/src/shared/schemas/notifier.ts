import { z } from 'zod';

// ============================================================================
// Notifier schemas
// ============================================================================

export const notifierTypeSchema = z.enum(['webhook', 'discord', 'script']);
export const notificationEventSchema = z.enum(['on_grab', 'on_download_complete', 'on_import', 'on_failure']);

export const createNotifierSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean().default(true),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.record(z.string(), z.unknown()),
});

export const updateNotifierSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  events: z.array(notificationEventSchema).min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type CreateNotifierInput = z.infer<typeof createNotifierSchema>;
export type UpdateNotifierInput = z.infer<typeof updateNotifierSchema>;

export const createNotifierFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean(),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.object({
    url: z.string().optional(),
    method: z.enum(['POST', 'PUT']).optional(),
    headers: z.string().optional(),
    bodyTemplate: z.string().optional(),
    webhookUrl: z.string().optional(),
    includeCover: z.boolean().optional(),
    path: z.string().optional(),
    timeout: z.number().int().min(1).max(300).optional(),
  }),
}).superRefine((data, ctx) => {
  if (data.type === 'webhook') {
    if (!data.settings.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'url'], message: 'URL is required' });
    }
  } else if (data.type === 'discord') {
    if (!data.settings.webhookUrl) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'webhookUrl'], message: 'Webhook URL is required' });
    }
  } else if (data.type === 'script') {
    if (!data.settings.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', 'path'], message: 'Script path is required' });
    }
  }
});

export type CreateNotifierFormData = z.infer<typeof createNotifierFormSchema>;
