import type { NotifierAdapter } from './types.js';
import { WebhookNotifier } from './webhook.js';
import { DiscordNotifier } from './discord.js';
import { ScriptNotifier } from './script.js';
import { EmailNotifier } from './email.js';
import { TelegramNotifier } from './telegram.js';
import { SlackNotifier } from './slack.js';
import { PushoverNotifier } from './pushover.js';
import { NtfyNotifier } from './ntfy.js';
import { GotifyNotifier } from './gotify.js';

type AdapterFactory = (settings: Record<string, unknown>) => NotifierAdapter;

function parseWebhookHeaders(headers: unknown): Record<string, string> | undefined {
  if (typeof headers !== 'string') return undefined;
  try {
    return JSON.parse(headers);
  } catch {
    return undefined;
  }
}

export const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  webhook: (s) => new WebhookNotifier({
    url: s.url as string,
    method: (s.method as 'POST' | 'PUT') || 'POST',
    headers: parseWebhookHeaders(s.headers),
    bodyTemplate: s.bodyTemplate as string | undefined,
  }),
  discord: (s) => new DiscordNotifier({
    webhookUrl: s.webhookUrl as string,
    includeCover: (s.includeCover as boolean) ?? true,
  }),
  script: (s) => new ScriptNotifier({
    path: s.path as string,
    timeout: (s.timeout as number) || 30,
  }),
  email: (s) => new EmailNotifier({
    host: s.smtpHost as string,
    port: (s.smtpPort as number) || 587,
    user: s.smtpUser as string | undefined,
    pass: s.smtpPass as string | undefined,
    tls: (s.smtpTls as boolean) ?? false,
    from: s.fromAddress as string,
    to: s.toAddress as string,
  }),
  telegram: (s) => new TelegramNotifier({
    botToken: s.botToken as string,
    chatId: s.chatId as string,
  }),
  slack: (s) => new SlackNotifier({
    webhookUrl: s.webhookUrl as string,
  }),
  pushover: (s) => new PushoverNotifier({
    token: s.pushoverToken as string,
    user: s.pushoverUser as string,
  }),
  ntfy: (s) => new NtfyNotifier({
    topic: s.ntfyTopic as string,
    serverUrl: s.ntfyServer as string | undefined,
  }),
  gotify: (s) => new GotifyNotifier({
    serverUrl: s.gotifyUrl as string,
    token: s.gotifyToken as string,
  }),
};
