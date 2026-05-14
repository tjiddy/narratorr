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

    it('accepts on_health_issue events', () => {
      const result = createNotifierFormSchema.safeParse({
        ...validBase, events: ['on_health_issue' as const],
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
  const base = { name: 'Test', enabled: true, events: ['on_grab' as const] };

  describe('positive cases — each type with valid settings', () => {
    it('accepts valid webhook settings (url)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'webhook', settings: { url: 'https://hooks.test' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid discord settings (webhookUrl)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'discord', settings: { webhookUrl: 'https://discord.com/webhook' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid script settings (path)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'script', settings: { path: '/usr/local/bin/notify.sh' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid email settings (smtpHost + fromAddress + toAddress)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'email', settings: { smtpHost: 'smtp.test', fromAddress: 'a@b.com', toAddress: 'c@d.com' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid telegram settings (botToken + chatId)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'telegram', settings: { botToken: 'tok123', chatId: '456' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid slack settings (webhookUrl)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'slack', settings: { webhookUrl: 'https://hooks.slack.com/test' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid pushover settings (pushoverToken + pushoverUser)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'pushover', settings: { pushoverToken: 'tok', pushoverUser: 'usr' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid ntfy settings (ntfyTopic)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'ntfy', settings: { ntfyTopic: 'audiobooks' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid gotify settings (gotifyUrl + gotifyToken)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'gotify', settings: { gotifyUrl: 'https://gotify.test', gotifyToken: 'tok' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('negative cases', () => {
    it('rejects missing required fields for webhook (no url)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'webhook', settings: { method: 'POST' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({ path: ['settings', 'url'] }),
        );
      }
    });

    it('rejects extra unknown fields', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'webhook', settings: { url: 'https://test', badField: true },
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty string for required fields', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'telegram', settings: { botToken: '', chatId: 'id' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('boundary values', () => {
    it('accepts timeout at minimum (1)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'script', settings: { path: '/test.sh', timeout: 1 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts timeout at maximum (300)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'script', settings: { path: '/test.sh', timeout: 300 },
      });
      expect(result.success).toBe(true);
    });

    it('webhook method must be POST or PUT', () => {
      const good = createNotifierSchema.safeParse({
        ...base, type: 'webhook', settings: { url: 'https://test', method: 'PUT' },
      });
      expect(good.success).toBe(true);

      const bad = createNotifierSchema.safeParse({
        ...base, type: 'webhook', settings: { url: 'https://test', method: 'DELETE' },
      });
      expect(bad.success).toBe(false);
    });
  });

  describe('notifier secret handling', () => {
    it('notifier settings are NOT masked (plaintext in/out)', () => {
      const result = createNotifierSchema.safeParse({
        ...base, type: 'telegram', settings: { botToken: 'secret-token-123', chatId: 'id' },
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.settings.botToken).toBe('secret-token-123');
    });
  });
});

describe('createNotifierSchema — invalid discriminant rejection', () => {
  it('rejects unknown type value with z.enum error on the type field', () => {
    const result = createNotifierSchema.safeParse({
      name: 'Bad Notifier',
      type: 'badNotifier',
      events: ['on_grab'],
      settings: { url: 'https://test.example' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['type'] }),
      );
    }
  });
});

describe('updateNotifierSchema — type required when settings present', () => {
  it('accepts update with settings + type', () => {
    const result = updateNotifierSchema.safeParse({
      type: 'webhook' as const, settings: { url: 'https://new.test' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts update without settings (type not required)', () => {
    const result = updateNotifierSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('rejects update with settings but no type', () => {
    const result = updateNotifierSchema.safeParse({
      settings: { url: 'https://test' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['type'], message: 'Type is required when settings are provided' }),
      );
    }
  });
});
