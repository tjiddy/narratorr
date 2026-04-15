import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockNotifier = {
  id: 1,
  name: 'Test Webhook',
  type: 'webhook' as const,
  enabled: true,
  events: ['on_grab', 'on_import'],
  settings: { url: 'https://example.com/hook' } as Record<string, unknown>,
  createdAt: new Date(),
};

describe('notifiers routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/notifiers', () => {
    it('returns all notifiers', async () => {
      vi.mocked(services.notifier.getAll).mockResolvedValue([mockNotifier]);
      const res = await app.inject({ method: 'GET', url: '/api/notifiers' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });
  });

  describe('GET /api/notifiers/:id', () => {
    it('returns notifier by id', async () => {
      vi.mocked(services.notifier.getById).mockResolvedValue(mockNotifier);
      const res = await app.inject({ method: 'GET', url: '/api/notifiers/1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Test Webhook' });
    });

    it('returns 404 for missing notifier', async () => {
      vi.mocked(services.notifier.getById).mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/notifiers/999' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/notifiers', () => {
    it('creates a notifier', async () => {
      vi.mocked(services.notifier.create).mockResolvedValue(mockNotifier);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: {
          name: 'Test Webhook',
          type: 'webhook',
          enabled: true,
          events: ['on_grab'],
          settings: { url: 'https://example.com/hook' },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'Test Webhook' });
    });

    it('validates required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: { type: 'webhook' }, // missing name, events, settings
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid typed settings and does not call service.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: { name: 'Bad', type: 'webhook', events: ['on_grab'], settings: { method: 'POST' } }, // missing url
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('settings/url');
      expect(services.notifier.create).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/notifiers/:id', () => {
    it('updates a notifier', async () => {
      vi.mocked(services.notifier.update).mockResolvedValue({ ...mockNotifier, name: 'Updated' });
      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/1',
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Updated' });
    });

    it('returns 404 for missing notifier', async () => {
      vi.mocked(services.notifier.update).mockResolvedValue(null);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/999',
        payload: { name: 'Nope' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when settings provided without type', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/1',
        payload: { settings: { url: 'https://test' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('type');
      expect(services.notifier.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/notifiers/:id', () => {
    it('deletes a notifier', async () => {
      vi.mocked(services.notifier.delete).mockResolvedValue(true);
      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('returns 404 for missing notifier', async () => {
      vi.mocked(services.notifier.delete).mockResolvedValue(false);
      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/999' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/notifiers/:id/test', () => {
    it('tests a notifier', async () => {
      vi.mocked(services.notifier.test).mockResolvedValue({ success: true });
      const res = await app.inject({ method: 'POST', url: '/api/notifiers/1/test' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/notifiers/test', () => {
    it('tests notifier config', async () => {
      vi.mocked(services.notifier.testConfig).mockResolvedValue({ success: true });
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: {
          name: 'Test',
          type: 'webhook',
          enabled: true,
          events: ['on_grab'],
          settings: { url: 'https://example.com/hook' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/notifiers (email)', () => {
    const emailSettings = {
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUser: 'user@example.com',
      smtpPass: 'secret',
      smtpTls: true,
      fromAddress: 'noreply@example.com',
      toAddress: 'admin@example.com',
    };

    it('creates email notifier with full settings and verifies service receives all email keys', async () => {
      const mockEmail = {
        id: 2,
        name: 'Email Notifier',
        type: 'email' as const,
        enabled: true,
        events: ['on_grab'],
        settings: emailSettings as Record<string, unknown>,
        createdAt: new Date(),
      };
      vi.mocked(services.notifier.create).mockResolvedValue(mockEmail);

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: {
          name: 'Email Notifier',
          type: 'email',
          enabled: true,
          events: ['on_grab'],
          settings: emailSettings,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        name: 'Email Notifier',
        type: 'email',
        settings: {
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpUser: 'user@example.com',
          smtpPass: 'secret',
          smtpTls: true,
          fromAddress: 'noreply@example.com',
          toAddress: 'admin@example.com',
        },
      });

      expect(services.notifier.create).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpUser: 'user@example.com',
            smtpPass: 'secret',
            smtpTls: true,
            fromAddress: 'noreply@example.com',
            toAddress: 'admin@example.com',
          }),
        }),
      );
    });
  });

  describe('POST /api/notifiers (telegram)', () => {
    const telegramSettings = {
      botToken: '123456:ABC-DEF',
      chatId: '987654321',
    };

    it('creates telegram notifier with full settings and verifies service receives botToken and chatId', async () => {
      const mockTelegram = {
        id: 3,
        name: 'Telegram Notifier',
        type: 'telegram' as const,
        enabled: true,
        events: ['on_import'],
        settings: telegramSettings as Record<string, unknown>,
        createdAt: new Date(),
      };
      vi.mocked(services.notifier.create).mockResolvedValue(mockTelegram);

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: {
          name: 'Telegram Notifier',
          type: 'telegram',
          enabled: true,
          events: ['on_import'],
          settings: telegramSettings,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        name: 'Telegram Notifier',
        type: 'telegram',
        settings: {
          botToken: '123456:ABC-DEF',
          chatId: '987654321',
        },
      });

      expect(services.notifier.create).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            botToken: '123456:ABC-DEF',
            chatId: '987654321',
          }),
        }),
      );
    });
  });

  describe('POST /api/notifiers/test (email)', () => {
    it('tests email config with full create payload and verifies testConfig receives type and settings', async () => {
      vi.mocked(services.notifier.testConfig).mockResolvedValue({ success: true });

      const emailSettings = {
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpTls: true,
        fromAddress: 'noreply@example.com',
        toAddress: 'admin@example.com',
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: {
          name: 'Email Test',
          type: 'email',
          enabled: true,
          events: ['on_grab'],
          settings: emailSettings,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(services.notifier.testConfig).toHaveBeenCalledWith({
        type: 'email',
        settings: expect.objectContaining({
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpUser: 'user@example.com',
          smtpPass: 'secret',
          smtpTls: true,
          fromAddress: 'noreply@example.com',
          toAddress: 'admin@example.com',
        }),
      });
    });
  });

  describe('POST /api/notifiers/test (telegram)', () => {
    it('tests telegram config with full create payload and verifies testConfig receives type and settings', async () => {
      vi.mocked(services.notifier.testConfig).mockResolvedValue({ success: true });

      const telegramSettings = {
        botToken: '123456:ABC-DEF',
        chatId: '987654321',
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: {
          name: 'Telegram Test',
          type: 'telegram',
          enabled: true,
          events: ['on_grab'],
          settings: telegramSettings,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(services.notifier.testConfig).toHaveBeenCalledWith({
        type: 'telegram',
        settings: expect.objectContaining({
          botToken: '123456:ABC-DEF',
          chatId: '987654321',
        }),
      });
    });
  });

  describe('POST /api/notifiers/test error paths', () => {
    it('returns error when testConfig rejects for email type', async () => {
      vi.mocked(services.notifier.testConfig).mockRejectedValue(new Error('SMTP connection refused'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: {
          name: 'Email Fail',
          type: 'email',
          enabled: true,
          events: ['on_grab'],
          settings: {
            smtpHost: 'bad.host',
            smtpPort: 587,
            smtpUser: 'user@example.com',
            smtpPass: 'secret',
            smtpTls: true,
            fromAddress: 'noreply@example.com',
            toAddress: 'admin@example.com',
          },
        },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });

    it('returns error when testConfig rejects for telegram type', async () => {
      vi.mocked(services.notifier.testConfig).mockRejectedValue(new Error('Telegram API error'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: {
          name: 'Telegram Fail',
          type: 'telegram',
          enabled: true,
          events: ['on_grab'],
          settings: {
            botToken: 'invalid-token',
            chatId: '123',
          },
        },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/notifiers validation (non-webhook)', () => {
    it('returns 400 for email type missing required top-level fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: {
          type: 'email',
          settings: { smtpHost: 'smtp.example.com' },
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
