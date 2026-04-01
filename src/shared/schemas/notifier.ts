import { z } from 'zod';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES } from '../notifier-registry';
import { NOTIFICATION_EVENTS } from '../notification-events';

// ============================================================================
// Notifier schemas
// ============================================================================

export const notifierTypeSchema = z.enum(NOTIFIER_TYPES);
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);

export const createNotifierSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean().default(true),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.record(z.string(), z.unknown()),
});

export const updateNotifierSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  events: z.array(notificationEventSchema).min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type CreateNotifierInput = z.infer<typeof createNotifierSchema>;
export type UpdateNotifierInput = z.infer<typeof updateNotifierSchema>;

export const createNotifierFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean(),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.object({
    // Webhook
    url: z.string().trim().optional(),
    method: z.enum(['POST', 'PUT']).optional(),
    headers: z.string().trim().optional(),
    bodyTemplate: z.string().trim().optional(),
    // Discord
    webhookUrl: z.string().trim().optional(),
    includeCover: z.boolean().optional(),
    // Script
    path: z.string().trim().optional(),
    timeout: z.number().int().min(1).max(300).optional(),
    // Email
    smtpHost: z.string().trim().optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpUser: z.string().trim().optional(),
    smtpPass: z.string().trim().optional(),
    smtpTls: z.boolean().optional(),
    fromAddress: z.string().trim().optional(),
    toAddress: z.string().trim().optional(),
    // Telegram
    botToken: z.string().trim().optional(),
    chatId: z.string().trim().optional(),
    // Slack (uses webhookUrl)
    // Pushover
    pushoverToken: z.string().trim().optional(),
    pushoverUser: z.string().trim().optional(),
    // ntfy
    ntfyTopic: z.string().trim().optional(),
    ntfyServer: z.string().trim().optional(),
    // Gotify
    gotifyUrl: z.string().trim().optional(),
    gotifyToken: z.string().trim().optional(),
  }),
}).superRefine((data, ctx) => {
  const meta = NOTIFIER_REGISTRY[data.type];
  if (!meta) return;
  for (const field of meta.requiredFields) {
    if (!data.settings[field.path as keyof typeof data.settings]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settings', field.path], message: field.message });
    }
  }
});

export type CreateNotifierFormData = z.infer<typeof createNotifierFormSchema>;
