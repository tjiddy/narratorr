import type { NotifierAdapter } from './types.js';
import type { NotifierType } from '../../shared/notifier-registry.js';
import type { NotifierSettingsMap, NotifierSettings } from '../../shared/schemas/notifier.js';
import { WebhookNotifier } from './webhook.js';
import { DiscordNotifier } from './discord.js';
import { ScriptNotifier } from './script.js';
import { EmailNotifier } from './email.js';
import { TelegramNotifier } from './telegram.js';
import { SlackNotifier } from './slack.js';
import { PushoverNotifier } from './pushover.js';
import { NtfyNotifier } from './ntfy.js';
import { GotifyNotifier } from './gotify.js';

function parseWebhookHeaders(headers: unknown): Record<string, string> | undefined {
  if (typeof headers !== 'string') return undefined;
  try {
    return JSON.parse(headers);
  } catch {
    return undefined;
  }
}

const TYPED_FACTORIES: { [K in NotifierType]: (settings: NotifierSettingsMap[K]) => NotifierAdapter } = {
  webhook: (s) => new WebhookNotifier({
    url: s.url,
    method: s.method || 'POST',
    headers: parseWebhookHeaders(s.headers),
    bodyTemplate: s.bodyTemplate,
  }),
  discord: (s) => new DiscordNotifier({
    webhookUrl: s.webhookUrl,
    includeCover: s.includeCover ?? true,
  }),
  script: (s) => new ScriptNotifier({
    path: s.path,
    timeout: s.timeout || 30,
  }),
  email: (s) => new EmailNotifier({
    host: s.smtpHost,
    port: s.smtpPort || 587,
    user: s.smtpUser,
    pass: s.smtpPass,
    tls: s.smtpTls ?? false,
    from: s.fromAddress,
    to: s.toAddress,
  }),
  telegram: (s) => new TelegramNotifier({
    botToken: s.botToken,
    chatId: s.chatId,
  }),
  slack: (s) => new SlackNotifier({
    webhookUrl: s.webhookUrl,
  }),
  pushover: (s) => new PushoverNotifier({
    token: s.pushoverToken,
    user: s.pushoverUser,
  }),
  ntfy: (s) => new NtfyNotifier({
    topic: s.ntfyTopic,
    serverUrl: s.ntfyServer,
  }),
  gotify: (s) => new GotifyNotifier({
    serverUrl: s.gotifyUrl,
    token: s.gotifyToken,
  }),
};

export type NotifierAdapterFactory = (settings: NotifierSettings) => NotifierAdapter;

export const ADAPTER_FACTORIES: Record<NotifierType, NotifierAdapterFactory> =
  TYPED_FACTORIES as Record<NotifierType, NotifierAdapterFactory>;
