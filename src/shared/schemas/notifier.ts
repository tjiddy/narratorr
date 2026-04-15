import { z } from 'zod';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES, type NotifierType } from '../notifier-registry';
import { NOTIFICATION_EVENTS } from '../notification-events';

// ============================================================================
// Notifier schemas
// ============================================================================

export const notifierTypeSchema = z.enum(NOTIFIER_TYPES);
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);

// ── Per-adapter settings schemas (strict — rejects unknown fields) ──────────

export const webhookSettingsSchema = z.object({
  url: z.string().trim().min(1),
  method: z.enum(['POST', 'PUT']).optional(),
  headers: z.string().trim().optional(),
  bodyTemplate: z.string().trim().optional(),
}).strict();

export const discordSettingsSchema = z.object({
  webhookUrl: z.string().trim().min(1),
  includeCover: z.boolean().optional(),
}).strict();

export const scriptSettingsSchema = z.object({
  path: z.string().trim().min(1),
  timeout: z.number().int().min(1).max(300).optional(),
}).strict();

export const emailSettingsSchema = z.object({
  smtpHost: z.string().trim().min(1),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().trim().optional(),
  smtpPass: z.string().trim().optional(),
  smtpTls: z.boolean().optional(),
  fromAddress: z.string().trim().min(1),
  toAddress: z.string().trim().min(1),
}).strict();

export const telegramSettingsSchema = z.object({
  botToken: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
}).strict();

export const slackSettingsSchema = z.object({
  webhookUrl: z.string().trim().min(1),
}).strict();

export const pushoverSettingsSchema = z.object({
  pushoverToken: z.string().trim().min(1),
  pushoverUser: z.string().trim().min(1),
}).strict();

export const ntfySettingsSchema = z.object({
  ntfyTopic: z.string().trim().min(1),
  ntfyServer: z.string().trim().optional(),
}).strict();

export const gotifySettingsSchema = z.object({
  gotifyUrl: z.string().trim().min(1),
  gotifyToken: z.string().trim().min(1),
}).strict();

// ── Settings types and dispatch map ─────────────────────────────────────────

export type WebhookSettings = z.infer<typeof webhookSettingsSchema>;
export type DiscordSettings = z.infer<typeof discordSettingsSchema>;
export type ScriptSettings = z.infer<typeof scriptSettingsSchema>;
export type EmailSettings = z.infer<typeof emailSettingsSchema>;
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;
export type SlackSettings = z.infer<typeof slackSettingsSchema>;
export type PushoverSettings = z.infer<typeof pushoverSettingsSchema>;
export type NtfySettings = z.infer<typeof ntfySettingsSchema>;
export type GotifySettings = z.infer<typeof gotifySettingsSchema>;

export type NotifierSettingsMap = {
  webhook: WebhookSettings;
  discord: DiscordSettings;
  script: ScriptSettings;
  email: EmailSettings;
  telegram: TelegramSettings;
  slack: SlackSettings;
  pushover: PushoverSettings;
  ntfy: NtfySettings;
  gotify: GotifySettings;
};

export type NotifierSettings = NotifierSettingsMap[NotifierType];

export const notifierSettingsSchemas: Record<NotifierType, z.ZodTypeAny> = {
  webhook: webhookSettingsSchema,
  discord: discordSettingsSchema,
  script: scriptSettingsSchema,
  email: emailSettingsSchema,
  telegram: telegramSettingsSchema,
  slack: slackSettingsSchema,
  pushover: pushoverSettingsSchema,
  ntfy: ntfySettingsSchema,
  gotify: gotifySettingsSchema,
};

// ── Server-side schemas ─────────────────────────────────────────────────────

function validateSettingsPerType(
  data: { type: string; settings: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  const schema = notifierSettingsSchemas[data.type as NotifierType];
  if (!schema) return;
  const result = schema.safeParse(data.settings);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['settings', ...issue.path] });
    }
  } else {
    data.settings = result.data as Record<string, unknown>;
  }
}

export const createNotifierSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  type: notifierTypeSchema,
  enabled: z.boolean().default(true),
  events: z.array(notificationEventSchema).min(1, 'Select at least one event'),
  settings: z.record(z.string(), z.unknown()),
}).superRefine(validateSettingsPerType);

export const updateNotifierSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  type: notifierTypeSchema.optional(),
  enabled: z.boolean().optional(),
  events: z.array(notificationEventSchema).min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
  if (data.settings !== undefined && !data.type) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Type is required when settings are provided' });
    return;
  }
  if (data.settings !== undefined && data.type) {
    validateSettingsPerType(data as { type: string; settings: Record<string, unknown> }, ctx);
  }
});

export type CreateNotifierInput = z.infer<typeof createNotifierSchema>;
export type UpdateNotifierInput = z.infer<typeof updateNotifierSchema>;

// ── Form schema (unchanged — uses superRefine + registry.requiredFields for zodResolver compat) ──

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
