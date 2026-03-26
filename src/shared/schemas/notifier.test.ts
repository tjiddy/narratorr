import { describe, it, expect } from 'vitest';
import { createNotifierFormSchema, createNotifierSchema, updateNotifierSchema } from './notifier.js';

const validBase = {
  name: 'Test Notifier',
  type: 'webhook' as const,
  enabled: true,
  events: ['on_grab' as const],
  settings: { url: 'https://hooks.example.com/test', method: 'POST' as const },
};

describe('createNotifierFormSchema', () => {
  describe('superRefine — type-specific validation', () => {
    it('accepts valid webhook config', () => {
      const result = createNotifierFormSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it('rejects webhook without url', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase,
        settings: { method: 'POST' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'url'],
            message: 'URL is required',
          }),
        );
      }
    });

    it('rejects discord without webhookUrl', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase,
        type: 'discord',
        settings: {},
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'webhookUrl'],
            message: 'Webhook URL is required',
          }),
        );
      }
    });

    it('accepts discord with webhookUrl', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase,
        type: 'discord',
        settings: { webhookUrl: 'https://discord.com/api/webhooks/123/abc' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects script without path', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase,
        type: 'script',
        settings: {},
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ['settings', 'path'],
            message: 'Script path is required',
          }),
        );
      }
    });

    it('accepts script with path', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase,
        type: 'script',
        settings: { path: '/usr/local/bin/notify.sh' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects email without smtpHost', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'email', settings: { fromAddress: 'a@b.com', toAddress: 'c@d.com' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['settings', 'smtpHost'] }));
      }
    });

    it('accepts email with required fields', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'email',
        settings: { smtpHost: 'smtp.test.com', fromAddress: 'a@b.com', toAddress: 'c@d.com' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects telegram without botToken', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'telegram', settings: { chatId: '123' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['settings', 'botToken'] }));
      }
    });

    it('accepts telegram with required fields', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'telegram', settings: { botToken: '123:ABC', chatId: '-100123' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects slack without webhookUrl', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'slack', settings: {},
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['settings', 'webhookUrl'] }));
      }
    });

    it('rejects pushover without token', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'pushover', settings: { pushoverUser: 'u' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['settings', 'pushoverToken'] }));
      }
    });

    it('accepts pushover with required fields', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'pushover', settings: { pushoverToken: 't', pushoverUser: 'u' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects ntfy without topic', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'ntfy', settings: {},
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['settings', 'ntfyTopic'] }));
      }
    });

    it('rejects gotify without serverUrl', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'gotify', settings: { gotifyToken: 't' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['settings', 'gotifyUrl'] }));
      }
    });

    it('accepts gotify with required fields', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, type: 'gotify', settings: { gotifyUrl: 'https://g.test', gotifyToken: 't' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts on_upgrade and on_health_issue events', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, events: ['on_upgrade' as const, 'on_health_issue' as const],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('base field validation', () => {
    it('rejects empty name', () => {
      const result = createNotifierFormSchema.safeParse({ ...validBase, name: '' });
      expect(result.success).toBe(false);
    });

    it('rejects empty events array', () => {
      const result = createNotifierFormSchema.safeParse({ ...validBase, events: [] });
      expect(result.success).toBe(false);
    });

    it('rejects invalid event', () => {
      const result = createNotifierFormSchema.safeParse({ ...validBase, events: ['invalid_event'] });
      expect(result.success).toBe(false);
    });

    it('rejects timeout out of range', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase,
        settings: { ...validBase.settings, timeout: 500 },
      });
      expect(result.success).toBe(false);
    });
  });
});

const validCreate = {
  name: 'Test Notifier',
  type: 'webhook' as const,
  enabled: true,
  events: ['on_grab' as const],
  settings: { url: 'https://hooks.example.com/test', method: 'POST' as const },
};

describe('createNotifierSchema — trim behavior', () => {
  it('rejects whitespace-only name', () => {
    const result = createNotifierSchema.safeParse({ ...validCreate, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createNotifierSchema.safeParse({ ...validCreate, name: '  My Notifier  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Notifier');
  });
});

describe('updateNotifierSchema — trim behavior', () => {
  it('rejects whitespace-only name when provided', () => {
    const result = updateNotifierSchema.safeParse({ name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name when provided', () => {
    const result = updateNotifierSchema.safeParse({ name: '  My Notifier  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Notifier');
  });
});

describe('createNotifierFormSchema — trim behavior', () => {
  it('rejects whitespace-only name', () => {
    const result = createNotifierFormSchema.safeParse({ ...validBase, name: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from name', () => {
    const result = createNotifierFormSchema.safeParse({ ...validBase, name: '  My Notifier  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('My Notifier');
  });
});
