import { describe, it, expect, expectTypeOf } from 'vitest';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES, type NotifierType, type NotifierTypeMetadata } from './notifier-registry.js';
import { notifierTypeSchema } from './schemas/notifier.js';

describe('NOTIFIER_REGISTRY', () => {
  const types = notifierTypeSchema.options;

  describe('type narrowing', () => {
    it('keys are narrowed to NotifierType — no string index signature', () => {
      expectTypeOf<keyof typeof NOTIFIER_REGISTRY>().toEqualTypeOf<NotifierType>();
    });

    it('each entry is structurally a NotifierTypeMetadata', () => {
      expectTypeOf<(typeof NOTIFIER_REGISTRY)[NotifierType]>().toExtend<NotifierTypeMetadata>();
    });

    it('indexing with a non-NotifierType key is a type error', () => {
      // @ts-expect-error — 'unknown' is not in NotifierType
      NOTIFIER_REGISTRY['unknown'];
    });
  });

  describe('schema-registry alignment', () => {
    it('has an entry for every notifierTypeSchema value', () => {
      for (const type of types) {
        expect(NOTIFIER_REGISTRY[type], `Missing registry entry for type: ${type}`).toBeDefined();
      }
    });

    it('registry keys exactly match notifierTypeSchema.options', () => {
      const registryKeys = Object.keys(NOTIFIER_REGISTRY).sort();
      expect(registryKeys).toEqual([...types].sort());
    });

    it('NOTIFIER_TYPES tuple matches notifierTypeSchema.options', () => {
      expect([...NOTIFIER_TYPES].sort()).toEqual([...types].sort());
    });
  });

  describe('metadata completeness', () => {
    it('every entry has label, defaultSettings, requiredFields, and viewSubtitle', () => {
      for (const type of types) {
        const meta = NOTIFIER_REGISTRY[type];
        expect(meta.label).toBeTypeOf('string');
        expect(meta.defaultSettings).toBeDefined();
        expect(Array.isArray(meta.requiredFields)).toBe(true);
        expect(meta.viewSubtitle).toBeTypeOf('function');
      }
    });

    it('webhook defaultSettings includes headers and bodyTemplate', () => {
      const defaults = NOTIFIER_REGISTRY.webhook.defaultSettings as Record<string, unknown>;
      expect(defaults).toHaveProperty('headers', '');
      expect(defaults).toHaveProperty('bodyTemplate', '');
    });

    it('email defaultSettings includes smtpUser and smtpPass', () => {
      const defaults = NOTIFIER_REGISTRY.email.defaultSettings as Record<string, unknown>;
      expect(defaults).toHaveProperty('smtpUser', '');
      expect(defaults).toHaveProperty('smtpPass', '');
    });

    it('ntfy defaultSettings includes ntfyServer', () => {
      const defaults = NOTIFIER_REGISTRY.ntfy.defaultSettings as Record<string, unknown>;
      expect(defaults).toHaveProperty('ntfyServer', '');
    });

    it('requiredFields paths are valid setting field names', () => {
      for (const type of types) {
        const meta = NOTIFIER_REGISTRY[type];
        for (const field of meta.requiredFields) {
          expect(field.path).toBeTypeOf('string');
          expect(field.message).toBeTypeOf('string');
        }
      }
    });
  });

  describe('viewSubtitle', () => {
    it('discord returns static "Discord" for valid webhook URL', () => {
      expect(NOTIFIER_REGISTRY.discord.viewSubtitle({ webhookUrl: 'https://discord.com/api/webhooks/123/abc' })).toBe('Discord');
    });

    it('discord returns "Discord" for empty webhookUrl', () => {
      expect(NOTIFIER_REGISTRY.discord.viewSubtitle({ webhookUrl: '' })).toBe('Discord');
    });

    it('slack returns static "Slack" for valid webhook URL', () => {
      expect(NOTIFIER_REGISTRY.slack.viewSubtitle({ webhookUrl: 'https://hooks.slack.com/T00/B00/XXX' })).toBe('Slack');
    });

    it('slack returns "Slack" for empty webhookUrl', () => {
      expect(NOTIFIER_REGISTRY.slack.viewSubtitle({ webhookUrl: '' })).toBe('Slack');
    });

    it('webhook returns hostname for valid URL', () => {
      expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: 'https://example.com/hook' })).toBe('example.com');
    });

    it('webhook returns hostname (IP) for URL with port', () => {
      expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: 'http://192.168.1.1:8080/hook' })).toBe('192.168.1.1');
    });

    it('webhook returns "Webhook" for empty URL', () => {
      expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: '' })).toBe('Webhook');
    });

    it('webhook returns "Webhook" for invalid URL', () => {
      expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: 'not-a-url' })).toBe('Webhook');
    });

    it('gotify returns hostname for valid URL', () => {
      expect(NOTIFIER_REGISTRY.gotify.viewSubtitle({ gotifyUrl: 'https://gotify.local:8080', gotifyToken: '' })).toBe('gotify.local');
    });

    it('gotify returns "Gotify" for empty URL', () => {
      expect(NOTIFIER_REGISTRY.gotify.viewSubtitle({ gotifyUrl: '' })).toBe('Gotify');
    });

    it('gotify returns "Gotify" for invalid URL', () => {
      expect(NOTIFIER_REGISTRY.gotify.viewSubtitle({ gotifyUrl: 'bad' })).toBe('Gotify');
    });

    it('email returns toAddress unchanged', () => {
      expect(NOTIFIER_REGISTRY.email.viewSubtitle({ toAddress: 'a@b.com' })).toBe('a@b.com');
    });

    it('telegram returns "Chat <id>" format', () => {
      expect(NOTIFIER_REGISTRY.telegram.viewSubtitle({ chatId: '123' })).toBe('Chat 123');
    });

    it('pushover returns static "Pushover"', () => {
      expect(NOTIFIER_REGISTRY.pushover.viewSubtitle({})).toBe('Pushover');
    });

    it('ntfy returns topic name', () => {
      expect(NOTIFIER_REGISTRY.ntfy.viewSubtitle({ ntfyTopic: 'alerts' })).toBe('alerts');
    });

    it('ntfy returns "Ntfy" fallback for empty topic', () => {
      expect(NOTIFIER_REGISTRY.ntfy.viewSubtitle({ ntfyTopic: '' })).toBe('Ntfy');
    });

    it('script returns path unchanged', () => {
      expect(NOTIFIER_REGISTRY.script.viewSubtitle({ path: '/usr/local/bin/notify.sh' })).toBe('/usr/local/bin/notify.sh');
    });

    it('script returns "script" fallback for empty path', () => {
      expect(NOTIFIER_REGISTRY.script.viewSubtitle({ path: '' })).toBe('script');
    });

    it('email returns "email" fallback for empty toAddress', () => {
      expect(NOTIFIER_REGISTRY.email.viewSubtitle({ toAddress: '' })).toBe('email');
    });

    it('telegram returns "Chat ?" fallback for empty chatId', () => {
      expect(NOTIFIER_REGISTRY.telegram.viewSubtitle({ chatId: '' })).toBe('Chat ?');
    });

    it('webhook strips credentials from URL', () => {
      expect(NOTIFIER_REGISTRY.webhook.viewSubtitle({ url: 'https://user:pass@secure.example.com/hook' })).toBe('secure.example.com');
    });
  });
});
