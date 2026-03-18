import type { CreateNotifierFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

export const NOTIFIER_TYPES = ['webhook', 'discord', 'script', 'email', 'telegram', 'slack', 'pushover', 'ntfy', 'gotify'] as const;
export type NotifierType = typeof NOTIFIER_TYPES[number];

type NotifierTypeMetadata = RegistryEntry<CreateNotifierFormData['settings']>;

export const NOTIFIER_REGISTRY: Record<string, NotifierTypeMetadata> = {
  webhook: {
    label: 'Webhook',
    defaultSettings: { url: '', method: 'POST' as const },
    requiredFields: [{ path: 'url', message: 'URL is required' }],
    viewSubtitle: (s) => (s.url as string) || 'webhook',
  },
  discord: {
    label: 'Discord',
    defaultSettings: { webhookUrl: '', includeCover: true },
    requiredFields: [{ path: 'webhookUrl', message: 'Webhook URL is required' }],
    viewSubtitle: (s) => (s.webhookUrl as string)?.replace(/^https:\/\/discord\.com\/api\/webhooks\//, '...') || 'discord',
  },
  script: {
    label: 'Custom Script',
    defaultSettings: { path: '', timeout: 30 },
    requiredFields: [{ path: 'path', message: 'Script path is required' }],
    viewSubtitle: (s) => (s.path as string) || 'script',
  },
  email: {
    label: 'Email',
    defaultSettings: { smtpHost: '', smtpPort: 587, smtpTls: false, fromAddress: '', toAddress: '' },
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
    viewSubtitle: (s) => (s.webhookUrl as string)?.replace(/^https:\/\/hooks\.slack\.com\//, '...') || 'slack',
  },
  pushover: {
    label: 'Pushover',
    defaultSettings: { pushoverToken: '', pushoverUser: '' },
    requiredFields: [
      { path: 'pushoverToken', message: 'API token is required' },
      { path: 'pushoverUser', message: 'User key is required' },
    ],
    viewSubtitle: () => 'pushover',
  },
  ntfy: {
    label: 'ntfy',
    defaultSettings: { ntfyTopic: '' },
    requiredFields: [{ path: 'ntfyTopic', message: 'Topic is required' }],
    viewSubtitle: (s) => (s.ntfyTopic as string) || 'ntfy',
  },
  gotify: {
    label: 'Gotify',
    defaultSettings: { gotifyUrl: '', gotifyToken: '' },
    requiredFields: [
      { path: 'gotifyUrl', message: 'Server URL is required' },
      { path: 'gotifyToken', message: 'App token is required' },
    ],
    viewSubtitle: (s) => (s.gotifyUrl as string)?.replace(/^https?:\/\//, '') || 'gotify',
  },
} satisfies Record<NotifierType, NotifierTypeMetadata>;

// EVENT_LABELS moved to src/shared/notification-events.ts (leaf module)
