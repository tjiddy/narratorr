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

describe('createNotifierFormSchema — settings trim (#284)', () => {
  it('trims whitespace from webhook url, headers, bodyTemplate', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      settings: { url: '  https://hooks.example.com  ', method: 'POST' as const, headers: '  X-Custom: val  ', bodyTemplate: '  {{title}}  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.url).toBe('https://hooks.example.com');
      expect(result.data.settings.headers).toBe('X-Custom: val');
      expect(result.data.settings.bodyTemplate).toBe('{{title}}');
    }
  });

  it('trims whitespace from discord/slack webhookUrl', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'discord' as const,
      settings: { webhookUrl: '  https://discord.com/api/webhooks/123  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.webhookUrl).toBe('https://discord.com/api/webhooks/123');
  });

  it('trims whitespace from script path', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'script' as const,
      settings: { path: '  /usr/local/bin/notify.sh  ', timeout: 30 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.path).toBe('/usr/local/bin/notify.sh');
  });

  it('trims whitespace from email smtpHost, smtpUser, smtpPass, fromAddress, toAddress', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'email' as const,
      settings: {
        smtpHost: '  smtp.example.com  ',
        smtpUser: '  user@example.com  ',
        smtpPass: '  secret  ',
        fromAddress: '  noreply@example.com  ',
        toAddress: '  admin@example.com  ',
        smtpPort: 587,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.smtpHost).toBe('smtp.example.com');
      expect(result.data.settings.smtpUser).toBe('user@example.com');
      expect(result.data.settings.smtpPass).toBe('secret');
      expect(result.data.settings.fromAddress).toBe('noreply@example.com');
      expect(result.data.settings.toAddress).toBe('admin@example.com');
    }
  });

  it('trims whitespace from telegram botToken, chatId', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'telegram' as const,
      settings: { botToken: '  123456:ABC  ', chatId: '  -100123  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.botToken).toBe('123456:ABC');
      expect(result.data.settings.chatId).toBe('-100123');
    }
  });

  it('trims whitespace from pushover pushoverToken, pushoverUser', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'pushover' as const,
      settings: { pushoverToken: '  token123  ', pushoverUser: '  user456  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.pushoverToken).toBe('token123');
      expect(result.data.settings.pushoverUser).toBe('user456');
    }
  });

  it('trims whitespace from ntfy ntfyTopic, ntfyServer', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'ntfy' as const,
      settings: { ntfyTopic: '  audiobooks  ', ntfyServer: '  https://ntfy.sh  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.ntfyTopic).toBe('audiobooks');
      expect(result.data.settings.ntfyServer).toBe('https://ntfy.sh');
    }
  });

  it('trims whitespace from gotify gotifyUrl, gotifyToken', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      type: 'gotify' as const,
      settings: { gotifyUrl: '  https://gotify.local  ', gotifyToken: '  token789  ' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.settings.gotifyUrl).toBe('https://gotify.local');
      expect(result.data.settings.gotifyToken).toBe('token789');
    }
  });

  it('whitespace-only optional settings fields produce empty string', () => {
    const result = createNotifierFormSchema.safeParse({
      ...validBase,
      settings: { url: 'https://hooks.example.com', method: 'POST' as const, headers: '   ' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settings.headers).toBe('');
  });
});

// #557 — Typed adapter settings schemas (discriminated unions)
describe('createNotifierSchema — typed settings validation', () => {
  describe('positive cases — each type with valid settings', () => {
    it.todo('accepts valid webhook settings (url)');
    it.todo('accepts valid discord settings (webhookUrl)');
    it.todo('accepts valid script settings (path)');
    it.todo('accepts valid email settings (smtpHost + fromAddress + toAddress)');
    it.todo('accepts valid telegram settings (botToken + chatId)');
    it.todo('accepts valid slack settings (webhookUrl)');
    it.todo('accepts valid pushover settings (pushoverToken + pushoverUser)');
    it.todo('accepts valid ntfy settings (ntfyTopic)');
    it.todo('accepts valid gotify settings (gotifyUrl + gotifyToken)');
  });

  describe('negative cases', () => {
    it.todo('rejects missing required fields for webhook (no url)');
    it.todo('rejects extra unknown fields');
    it.todo('rejects wrong type discriminator');
  });

  describe('boundary values', () => {
    it.todo('accepts timeout at minimum (1)');
    it.todo('accepts timeout at maximum (300)');
    it.todo('webhook method must be POST or PUT');
  });

  describe('notifier secret handling', () => {
    it.todo('notifier settings are NOT masked (plaintext in/out)');
  });
});

describe('updateNotifierSchema — type required when settings present', () => {
  it.todo('accepts update with settings + type');
  it.todo('accepts update without settings (type not required)');
  it.todo('rejects update with settings but no type');
});
