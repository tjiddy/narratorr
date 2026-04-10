import type { CreateNotifierFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

export const NOTIFIER_TYPES = ['webhook', 'discord', 'script', 'email', 'telegram', 'slack', 'pushover', 'ntfy', 'gotify'] as const;
export type NotifierType = typeof NOTIFIER_TYPES[number];

type NotifierTypeMetadata = RegistryEntry<CreateNotifierFormData['settings']>;

function extractHostname(url: string, fallback: string): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
}

export const NOTIFIER_REGISTRY: Record<string, NotifierTypeMetadata> = {
  webhook: {
    label: 'Webhook',
    defaultSettings: { url: '', method: 'POST' as const, headers: '', bodyTemplate: '' },
    requiredFields: [{ path: 'url', message: 'URL is required' }],
    viewSubtitle: (s) => extractHostname(s.url as string, 'Webhook'),
  },
  discord: {
    label: 'Discord',
    defaultSettings: { webhookUrl: '', includeCover: true },
    requiredFields: [{ path: 'webhookUrl', message: 'Webhook URL is required' }],
    viewSubtitle: () => 'Discord',
  },
  script: {
    label: 'Custom Script',
    defaultSettings: { path: '', timeout: 30 },
    requiredFields: [{ path: 'path', message: 'Script path is required' }],
    viewSubtitle: (s) => (s.path as string) || 'script',
  },
  email: {
    label: 'Email',
    defaultSettings: { smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', smtpTls: false, fromAddress: '', toAddress: '' },
    requiredFields: [
      { path: 'smtpHost', message: 'SMTP host is required' },
      { path: 'fromAddress', message: 'From address is required' },
      { path: 'toAddress', message: 'To address is required' },
    ],
    viewSubtitle: (s) => (s.toAddress as string) || 'email',
  },
  telegram: {
    label: 'Telegram',
    defaultSettings: { botToken: '', chatId: '' },
    requiredFields: [
      { path: 'botToken', message: 'Bot token is required' },
      { path: 'chatId', message: 'Chat ID is required' },
    ],
    viewSubtitle: (s) => `Chat ${(s.chatId as string) || '?'}`,
  },
  slack: {
    label: 'Slack',
    defaultSettings: { webhookUrl: '' },
    requiredFields: [{ path: 'webhookUrl', message: 'Webhook URL is required' }],
    viewSubtitle: () => 'Slack',
  },
  pushover: {
    label: 'Pushover',
    defaultSettings: { pushoverToken: '', pushoverUser: '' },
    requiredFields: [
      { path: 'pushoverToken', message: 'API token is required' },
      { path: 'pushoverUser', message: 'User key is required' },
    ],
    viewSubtitle: () => 'Pushover',
  },
  ntfy: {
    label: 'ntfy',
    defaultSettings: { ntfyTopic: '', ntfyServer: '' },
    requiredFields: [{ path: 'ntfyTopic', message: 'Topic is required' }],
    viewSubtitle: (s) => (s.ntfyTopic as string) || 'Ntfy',
  },
  gotify: {
    label: 'Gotify',
    defaultSettings: { gotifyUrl: '', gotifyToken: '' },
    requiredFields: [
      { path: 'gotifyUrl', message: 'Server URL is required' },
      { path: 'gotifyToken', message: 'App token is required' },
    ],
    viewSubtitle: (s) => extractHostname(s.gotifyUrl as string, 'Gotify'),
  },
} satisfies Record<NotifierType, NotifierTypeMetadata>;

// EVENT_LABELS moved to src/shared/notification-events.ts (leaf module)
