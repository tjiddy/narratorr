import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotifierService } from './notifier.service.js';

// Mock DB chain helper
function mockDbChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set'];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return chain;
}

function createMockDb() {
  return {
    select: vi.fn().mockReturnValue(mockDbChain()),
    insert: vi.fn().mockReturnValue(mockDbChain()),
    update: vi.fn().mockReturnValue(mockDbChain()),
    delete: vi.fn().mockReturnValue(mockDbChain()),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
  };
}

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

    it('returns error for unknown type', async () => {
      const result = await service.testConfig({
        type: 'unknown',
        settings: {},
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown notifier type');
    });
  });
});
