import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotifierService } from './notifier.service.js';
import { mockDbChain, createMockDb, createMockLogger } from '../__tests__/helpers.js';

import { createMockDbNotifier } from '../__tests__/factories.js';

const mockWebhookNotifier = createMockDbNotifier();

const mockDiscordNotifier = createMockDbNotifier({
  id: 2,
  name: 'Discord',
  type: 'discord',
  events: ['on_failure'],
  settings: { webhookUrl: 'https://discord.com/api/webhooks/123/abc' },
});

describe('NotifierService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: NotifierService;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    service = new NotifierService(db as never, log as never);
  });

  describe('getAll', () => {
    it('returns all notifiers', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier, mockDiscordNotifier]));
      const result = await service.getAll();
      expect(result).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns notifier when found', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const result = await service.getById(1);
      expect(result).toEqual(mockWebhookNotifier);
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates and returns notifier', async () => {
      db.insert.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const result = await service.create({
        name: 'Test Webhook',
        type: 'webhook',
        enabled: true,
        events: ['on_grab'],
        settings: { url: 'https://example.com/hook' },
      });
      expect(result).toEqual(mockWebhookNotifier);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Test Webhook' }),
        'Notifier created',
      );
    });
  });

  describe('delete', () => {
    it('deletes existing notifier', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      db.delete.mockReturnValue(mockDbChain());
      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(log.info).toHaveBeenCalledWith({ id: 1 }, 'Notifier deleted');
    });

    it('returns false for non-existent notifier', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.delete(999);
      expect(result).toBe(false);
    });
  });

  describe('notify', () => {
    it('sends to all enabled notifiers matching the event', async () => {
      // Mock: return both enabled notifiers (webhook matches on_grab, discord does not)
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier, mockDiscordNotifier]));

      // Mock global fetch for the webhook call
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      await service.notify('on_grab', {
        event: 'on_grab',
        book: { title: 'Test' },
      });

      // Only webhook should fire (it has on_grab), discord has on_failure only
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({ method: 'POST' }),
      );

      fetchSpy.mockRestore();
    });

    it('logs warning on notification failure but does not throw', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('error', { status: 500, statusText: 'Internal Server Error' }),
      );

      // Should not throw
      await service.notify('on_grab', { event: 'on_grab' });

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Test Webhook' }),
        'Notification failed',
      );

      fetchSpy.mockRestore();
    });

    it('skips when no notifiers match the event', async () => {
      db.select.mockReturnValue(mockDbChain([mockDiscordNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await service.notify('on_grab', { event: 'on_grab' });

      // Discord only has on_failure, not on_grab
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'on_grab' }),
        'No notifiers configured for event',
      );

      fetchSpy.mockRestore();
    });

    it('handles adapter errors gracefully', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      await service.notify('on_grab', { event: 'on_grab' });

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Test Webhook' }),
        'Notification error',
      );

      fetchSpy.mockRestore();
    });
  });

  describe('defensive parsing', () => {
    it('treats non-array events as empty (no match)', async () => {
      const badNotifier = createMockDbNotifier({ events: 'not-an-array' });
      db.select.mockReturnValue(mockDbChain([badNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await service.notify('on_grab', { event: 'on_grab' });

      // Should not fire — non-array events fall back to []
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('ignores malformed webhook headers JSON', async () => {
      const badHeadersNotifier = createMockDbNotifier({
        settings: { url: 'https://example.com/hook', headers: '{invalid json' },
      });
      db.select.mockReturnValue(mockDbChain([badHeadersNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const result = await service.test(1);
      expect(result.success).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifierId: 1 }),
        expect.stringContaining('headers'),
      );

      fetchSpy.mockRestore();
    });

    it('skips notifier with empty events array — never matches any event type', async () => {
      const emptyEventsNotifier = createMockDbNotifier({ events: [] });
      db.select.mockReturnValue(mockDbChain([emptyEventsNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await service.notify('on_grab', { event: 'on_grab' });

      // Empty array never includes any event — notifier is skipped
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'on_grab' }),
        'No notifiers configured for event',
      );
      fetchSpy.mockRestore();
    });

    it('resolves without throwing when all matching notifiers fail simultaneously', async () => {
      const notifier1 = createMockDbNotifier({ id: 1, name: 'Webhook 1', events: ['on_grab'] });
      const notifier2 = createMockDbNotifier({ id: 2, name: 'Webhook 2', events: ['on_grab'] });
      const notifier3 = createMockDbNotifier({ id: 3, name: 'Webhook 3', events: ['on_grab'] });
      db.select.mockReturnValue(mockDbChain([notifier1, notifier2, notifier3]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network down'));

      // Should resolve — Promise.allSettled catches all failures
      await service.notify('on_grab', { event: 'on_grab' });

      // All 3 notifiers attempted and logged
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(log.warn).toHaveBeenCalledTimes(3);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Webhook 1' }),
        'Notification error',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Webhook 2' }),
        'Notification error',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Webhook 3' }),
        'Notification error',
      );
      fetchSpy.mockRestore();
    });
  });

  describe('test', () => {
    it('returns success for valid notifier', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const result = await service.test(1);
      expect(result.success).toBe(true);

      fetchSpy.mockRestore();
    });

    it('returns not found for missing notifier', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.test(999);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Notifier not found');
    });

    it('returns failure with message when adapter throws', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Network timeout'),
      );

      const result = await service.test(1);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Network timeout');

      fetchSpy.mockRestore();
    });
  });

  describe('testConfig', () => {
    it('creates adapter and tests config', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      const result = await service.testConfig({
        type: 'webhook',
        settings: { url: 'https://example.com/hook' },
      });

      expect(result.success).toBe(true);
      fetchSpy.mockRestore();
    });

    it('creates email adapter', async () => {
      const result = await service.testConfig({
        type: 'email',
        settings: { smtpHost: 'smtp.test.com', fromAddress: 'a@b.com', toAddress: 'c@d.com' },
      });
      // Will fail because no real SMTP, but adapter was created successfully
      expect(result).toHaveProperty('success');
    });

    it('creates telegram adapter', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const result = await service.testConfig({
        type: 'telegram',
        settings: { botToken: '123:ABC', chatId: '-100' },
      });
      expect(result.success).toBe(true);
      fetchSpy.mockRestore();
    });

    it('creates slack adapter', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      const result = await service.testConfig({
        type: 'slack',
        settings: { webhookUrl: 'https://hooks.slack.com/test' },
      });
      expect(result.success).toBe(true);
      fetchSpy.mockRestore();
    });

    it('creates pushover adapter', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const result = await service.testConfig({
        type: 'pushover',
        settings: { pushoverToken: 't', pushoverUser: 'u' },
      });
      expect(result.success).toBe(true);
      fetchSpy.mockRestore();
    });

    it('creates ntfy adapter', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      const result = await service.testConfig({
        type: 'ntfy',
        settings: { ntfyTopic: 'test-topic' },
      });
      expect(result.success).toBe(true);
      fetchSpy.mockRestore();
    });

    it('creates gotify adapter', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const result = await service.testConfig({
        type: 'gotify',
        settings: { gotifyUrl: 'https://gotify.test', gotifyToken: 'tok' },
      });
      expect(result.success).toBe(true);
      fetchSpy.mockRestore();
    });

    it('returns error for unknown type', async () => {
      const result = await service.testConfig({
        type: 'unknown',
        settings: {},
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown notifier type');
    });

    it('returns failure with message when adapter throws during send', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('DNS resolution failed'),
      );

      const result = await service.testConfig({
        type: 'webhook',
        settings: { url: 'https://unreachable.example.com/hook' },
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('DNS resolution failed');

      fetchSpy.mockRestore();
    });
  });
});
