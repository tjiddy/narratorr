import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotifierService } from './notifier.service.js';
import { mockDbChain, createMockDb, createMockLogger } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, encrypt, isEncrypted } from '../utils/secret-codec.js';
import { ADAPTER_FACTORIES, type NotifierAdapter } from '../../core/index.js';

import { createMockDbNotifier } from '../__tests__/factories.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

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
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
    service = new NotifierService(db as never, log as never);
  });

  afterEach(() => {
    _resetKey();
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
        'Notification failed',
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
        'Notification failed',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Webhook 2' }),
        'Notification failed',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Webhook 3' }),
        'Notification failed',
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

    // ── #782 log parity with IndexerService.testConfig ─────────────────────
    describe('debug logging parity with indexer.testConfig (#782)', () => {
      it('emits entry + exit debug logs in order on success', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('ok', { status: 200 }),
        );

        const result = await service.testConfig({
          type: 'webhook',
          settings: { url: 'https://example.com/hook' },
        });

        expect(result.success).toBe(true);

        const debugCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls;
        const entryIdx = debugCalls.findIndex((c: unknown[]) => c[1] === 'Testing notifier config');
        const exitIdx = debugCalls.findIndex((c: unknown[]) => c[1] === 'Notifier config test result');
        expect(entryIdx).toBeGreaterThanOrEqual(0);
        expect(exitIdx).toBeGreaterThan(entryIdx);
        expect(debugCalls[entryIdx][0]).toEqual({ type: 'webhook' });
        expect(debugCalls[exitIdx][0]).toEqual({ type: 'webhook', success: true, message: undefined });

        fetchSpy.mockRestore();
      });

      it('exit log carries adapter failure message', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('nope', { status: 401, statusText: 'Unauthorized' }),
        );

        const result = await service.testConfig({
          type: 'webhook',
          settings: { url: 'https://example.com/hook' },
        });

        expect(result.success).toBe(false);
        expect(log.debug).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'webhook', success: false, message: result.message }),
          'Notifier config test result',
        );

        fetchSpy.mockRestore();
      });

      it('does not emit exit log on Notifier-not-found early return', async () => {
        db.select.mockReturnValue(mockDbChain([]));

        await service.testConfig({
          type: 'webhook',
          settings: { url: '********' },
          id: 999,
        });

        expect(log.debug).toHaveBeenCalledWith({ type: 'webhook' }, 'Testing notifier config');
        expect(log.debug).not.toHaveBeenCalledWith(
          expect.anything(),
          'Notifier config test result',
        );
      });

      it('does not emit either debug log when adapter creation throws', async () => {
        await service.testConfig({
          type: 'unknown',
          settings: {},
        });

        // Entry log fires (inside try, before throw) but exit log must not.
        expect(log.debug).not.toHaveBeenCalledWith(
          expect.anything(),
          'Notifier config test result',
        );
      });

      it('debug payloads contain no secret fields', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('ok', { status: 200 }),
        );

        await service.testConfig({
          type: 'webhook',
          settings: {
            url: 'https://example.com/hook',
            webhookUrl: 'https://example.com/hook',
            botToken: 'secret',
            smtpPass: 'pw',
            pushoverToken: 'tok',
            gotifyToken: 'tok',
            headers: '{"Authorization":"Bearer x"}',
          },
        });

        const SECRETS = ['url', 'webhookUrl', 'botToken', 'smtpPass', 'pushoverToken', 'gotifyToken', 'headers'];
        for (const call of (log.debug as ReturnType<typeof vi.fn>).mock.calls) {
          if (call[1] !== 'Testing notifier config' && call[1] !== 'Notifier config test result') continue;
          const payload = call[0] as Record<string, unknown>;
          for (const field of SECRETS) {
            expect(payload).not.toHaveProperty(field);
          }
        }

        fetchSpy.mockRestore();
      });
    });
  });

  // ── #731 Encrypt and mask notifier secrets ─────────────────────────────
  describe('#731 encryption — create', () => {
    it('encrypts secret fields before insert (webhook url + headers)', async () => {
      const insertChain = mockDbChain([createMockDbNotifier()]);
      db.insert.mockReturnValue(insertChain);

      await service.create({
        name: 'Hook',
        type: 'webhook',
        enabled: true,
        events: ['on_grab'],
        settings: { url: 'https://hook.example.com', headers: '{"Authorization":"Bearer x"}' },
      });

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(isEncrypted(valuesArg.settings.url as string)).toBe(true);
      expect(isEncrypted(valuesArg.settings.headers as string)).toBe(true);
    });

    it('encrypts telegram botToken', async () => {
      const insertChain = mockDbChain([createMockDbNotifier({ type: 'telegram', settings: {} })]);
      db.insert.mockReturnValue(insertChain);

      await service.create({
        name: 'TG',
        type: 'telegram',
        enabled: true,
        events: ['on_grab'],
        settings: { botToken: '12:abc', chatId: '-100' },
      });

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(isEncrypted(valuesArg.settings.botToken as string)).toBe(true);
      expect(valuesArg.settings.chatId).toBe('-100');
    });

    it('encrypts email smtpPass', async () => {
      const insertChain = mockDbChain([createMockDbNotifier({ type: 'email', settings: {} })]);
      db.insert.mockReturnValue(insertChain);

      await service.create({
        name: 'Email',
        type: 'email',
        enabled: true,
        events: ['on_grab'],
        settings: { smtpHost: 'smtp.test', smtpPass: 'pw', fromAddress: 'a@b.c', toAddress: 'c@d.e' },
      });

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(isEncrypted(valuesArg.settings.smtpPass as string)).toBe(true);
      expect(valuesArg.settings.smtpHost).toBe('smtp.test');
    });

    it('returns decrypted row from create', async () => {
      const encrypted = encrypt('https://hook.example.com', TEST_KEY);
      db.insert.mockReturnValue(mockDbChain([
        createMockDbNotifier({ settings: { url: encrypted } }),
      ]));

      const result = await service.create({
        name: 'X', type: 'webhook', enabled: true, events: ['on_grab'],
        settings: { url: 'https://hook.example.com' },
      });

      expect(result.settings).toMatchObject({ url: 'https://hook.example.com' });
    });
  });

  describe('#731 encryption — getAll / getById decryption', () => {
    it('getAll returns decrypted settings', async () => {
      const enc = encrypt('https://hook.example.com', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([createMockDbNotifier({ settings: { url: enc } })]));

      const rows = await service.getAll();
      expect(rows[0].settings).toMatchObject({ url: 'https://hook.example.com' });
    });

    it('getById returns decrypted settings', async () => {
      const enc = encrypt('123:abc', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([createMockDbNotifier({ type: 'telegram', settings: { botToken: enc, chatId: '1' } })]));

      const row = await service.getById(1);
      expect(row?.settings).toMatchObject({ botToken: '123:abc', chatId: '1' });
    });
  });

  describe('#731 encryption — update sentinel preservation (AC9)', () => {
    it('PUT with ******** sentinel preserves stored ciphertext byte-for-byte', async () => {
      const encryptedUrl = encrypt('https://real.hook/path', TEST_KEY);
      const existing = createMockDbNotifier({ settings: { url: encryptedUrl, method: 'POST' } });

      db.select.mockReturnValue(mockDbChain([existing]));
      const updateChain = mockDbChain([existing]);
      db.update.mockReturnValue(updateChain);

      await service.update(1, {
        type: 'webhook',
        settings: { url: '********', method: 'PUT' },
      });

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0][0] as { settings: Record<string, unknown> };
      // Exact byte-for-byte match — same IV, auth tag, ciphertext
      expect(setArg.settings.url).toBe(encryptedUrl);
      expect(setArg.settings.method).toBe('PUT');
    });

    it('PUT with new real value re-encrypts', async () => {
      const oldEnc = encrypt('old-token', TEST_KEY);
      const existing = createMockDbNotifier({ type: 'telegram', settings: { botToken: oldEnc, chatId: '1' } });

      db.select.mockReturnValue(mockDbChain([existing]));
      const updateChain = mockDbChain([existing]);
      db.update.mockReturnValue(updateChain);

      await service.update(1, {
        type: 'telegram',
        settings: { botToken: 'new-token', chatId: '1' },
      });

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(isEncrypted(setArg.settings.botToken as string)).toBe(true);
      expect(setArg.settings.botToken).not.toBe(oldEnc);
    });

    // #844 — entity-aware allowlist on resolveSentinelFields
    it('update rejects sentinel on a non-secret field rather than silently substituting it', async () => {
      const existing = createMockDbNotifier({ type: 'webhook', settings: { url: 'https://hook', method: 'POST' } });
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain([existing]));

      // method is NOT in the notifier secret allowlist — must throw.
      await expect(
        service.update(1, {
          type: 'webhook',
          settings: { url: 'https://hook', method: '********' },
        }),
      ).rejects.toThrow(/non-secret field: method/);
    });

    it('testConfig surfaces a typed error for sentinel on a non-secret field', async () => {
      const existing = createMockDbNotifier({ type: 'webhook', settings: { url: 'https://hook', method: 'POST' } });
      db.select.mockReturnValue(mockDbChain([existing]));

      const result = await service.testConfig({
        type: 'webhook',
        settings: { url: 'https://hook', method: '********' },
        id: 1,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/non-secret field: method/);
    });
  });

  describe('#731 encryption — notify decrypts before adapter (AC4)', () => {
    it('notify() decrypts webhook url so adapter sees plaintext', async () => {
      const enc = encrypt('https://real.hook.example.com', TEST_KEY);
      const notifier = createMockDbNotifier({
        events: ['on_grab'],
        settings: { url: enc, method: 'POST' },
      });
      db.select.mockReturnValue(mockDbChain([notifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await service.notify('on_grab', { event: 'on_grab' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://real.hook.example.com',
        expect.objectContaining({ method: 'POST' }),
      );
      fetchSpy.mockRestore();
    });

    it('notify() decrypts telegram botToken so adapter sees plaintext', async () => {
      const enc = encrypt('123:secret-token', TEST_KEY);
      const notifier = createMockDbNotifier({
        type: 'telegram',
        events: ['on_grab'],
        settings: { botToken: enc, chatId: '-100' },
      });
      db.select.mockReturnValue(mockDbChain([notifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      await service.notify('on_grab', { event: 'on_grab', book: { title: 'X' } });

      // The Telegram adapter encodes the bot token in the URL path
      const callUrl = fetchSpy.mock.calls[0][0] as string;
      expect(callUrl).toContain('123:secret-token');
      expect(callUrl).not.toContain('$ENC$');
      fetchSpy.mockRestore();
    });
  });

  describe('#731 encryption — testConfig sentinel resolution (AC5)', () => {
    it('with id and ******** sentinel: resolves against decrypted saved settings', async () => {
      const enc = encrypt('https://real.hook.example.com', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([
        createMockDbNotifier({ id: 5, settings: { url: enc, method: 'POST' } }),
      ]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      const result = await service.testConfig({
        type: 'webhook',
        settings: { url: '********', method: 'POST' },
        id: 5,
      });

      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://real.hook.example.com',
        expect.anything(),
      );
      fetchSpy.mockRestore();
    });

    it('with id and a non-sentinel value: uses incoming value as-is', async () => {
      db.select.mockReturnValue(mockDbChain([
        createMockDbNotifier({ id: 5, settings: { url: 'https://old.hook' } }),
      ]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await service.testConfig({
        type: 'webhook',
        settings: { url: 'https://new.hook', method: 'POST' },
        id: 5,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://new.hook',
        expect.anything(),
      );
      fetchSpy.mockRestore();
    });

    it('without id (create-mode): incoming value used directly, no DB lookup', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      await service.testConfig({
        type: 'webhook',
        settings: { url: 'https://example.com/hook' },
      });

      expect(db.select).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.anything(),
      );
      fetchSpy.mockRestore();
    });

    it('with id but notifier not found: returns failure', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.testConfig({
        type: 'webhook',
        settings: { url: '********' },
        id: 999,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  // ── #781 Adapter caching ────────────────────────────────────────────────
  describe('#781 adapter caching', () => {
    function makeStubAdapter(): NotifierAdapter & { send: ReturnType<typeof vi.fn>; test: ReturnType<typeof vi.fn> } {
      return {
        type: 'webhook',
        send: vi.fn().mockResolvedValue({ success: true }),
        test: vi.fn().mockResolvedValue({ success: true }),
      };
    }

    it('builds adapter once across multiple notify() calls for the same notifier', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const adapter = makeStubAdapter();
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockReturnValue(adapter);

      await service.notify('on_grab', { event: 'on_grab' });
      await service.notify('on_grab', { event: 'on_grab' });
      await service.notify('on_grab', { event: 'on_grab' });

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(adapter.send).toHaveBeenCalledTimes(3);
      factorySpy.mockRestore();
    });

    it('caches a separate adapter per notifier id', async () => {
      const n1 = createMockDbNotifier({ id: 1, name: 'W1', events: ['on_grab'] });
      const n2 = createMockDbNotifier({ id: 2, name: 'W2', events: ['on_grab'] });
      db.select.mockReturnValue(mockDbChain([n1, n2]));

      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockImplementation(() => makeStubAdapter());

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(2);

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(2);
      factorySpy.mockRestore();
    });

    it('update() invalidates the cache and the next call sees fresh decrypted settings', async () => {
      const original = createMockDbNotifier({ id: 1, settings: { url: 'https://old.hook' } });
      db.select.mockReturnValue(mockDbChain([original]));
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockImplementation(() => makeStubAdapter());

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy.mock.calls[0][0]).toMatchObject({ url: 'https://old.hook' });

      const updated = createMockDbNotifier({ id: 1, settings: { url: 'https://new.hook' } });
      db.update.mockReturnValue(mockDbChain([updated]));
      await service.update(1, { settings: { url: 'https://new.hook' } });

      // Subsequent notify reads the updated row from the DB.
      db.select.mockReturnValue(mockDbChain([updated]));
      await service.notify('on_grab', { event: 'on_grab' });

      expect(factorySpy).toHaveBeenCalledTimes(2);
      expect(factorySpy.mock.calls[1][0]).toMatchObject({ url: 'https://new.hook' });
      factorySpy.mockRestore();
    });

    it('update() with no settings change still invalidates the cached adapter', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockImplementation(() => makeStubAdapter());

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(1);

      db.update.mockReturnValue(mockDbChain([{ ...mockWebhookNotifier, name: 'Renamed' }]));
      await service.update(1, { name: 'Renamed' });

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(2);
      factorySpy.mockRestore();
    });

    it('delete() invalidates the cached adapter', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockImplementation(() => makeStubAdapter());

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(1);

      db.delete.mockReturnValue(mockDbChain());
      await service.delete(1);

      // Direct getAdapter call — if cache were still populated it would return
      // the prior adapter without invoking the factory. (Factory mock loosens
      // the enum-typed events column, so cast through never for the call.)
      service.getAdapter(mockWebhookNotifier as never);
      expect(factorySpy).toHaveBeenCalledTimes(2);
      factorySpy.mockRestore();
    });

    it('test(id) reuses the cached adapter warmed by notify()', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const adapter = makeStubAdapter();
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockReturnValue(adapter);

      await service.notify('on_grab', { event: 'on_grab' });
      const result = await service.test(1);

      expect(result.success).toBe(true);
      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(adapter.test).toHaveBeenCalledTimes(1);
      factorySpy.mockRestore();
    });

    it('testConfig() builds an ad-hoc adapter and does not touch the cache', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const cachedAdapter = makeStubAdapter();
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook')
        .mockReturnValueOnce(cachedAdapter)
        .mockReturnValueOnce(makeStubAdapter());

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(1);

      await service.testConfig({
        type: 'webhook',
        settings: { url: 'https://probe.example.com/hook' },
      });
      expect(factorySpy).toHaveBeenCalledTimes(2);

      // Cached adapter is still in place — next notify reuses it, no new factory call.
      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(2);
      expect(cachedAdapter.send).toHaveBeenCalledTimes(2);
      factorySpy.mockRestore();
    });

    it('factory throw is swallowed by notify() and does not poison the cache', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const goodAdapter = makeStubAdapter();
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook')
        .mockImplementationOnce(() => { throw new Error('factory boom'); })
        .mockImplementationOnce(() => goodAdapter);

      // First notify: factory throws, Promise.allSettled catches, no rejection bubbles up.
      await expect(service.notify('on_grab', { event: 'on_grab' })).resolves.toBeUndefined();
      expect(factorySpy).toHaveBeenCalledTimes(1);

      // Second notify: factory is retried, succeeds, adapter is cached and used.
      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(2);
      expect(goodAdapter.send).toHaveBeenCalledTimes(1);
      factorySpy.mockRestore();
    });

    it('logs "Notification error" via service-level catch when the adapter factory throws', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook')
        .mockImplementationOnce(() => { throw new Error('factory boom'); });

      await service.notify('on_grab', { event: 'on_grab' });

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          notifier: 'Test Webhook',
          notifierType: 'webhook',
          event: 'on_grab',
          error: expect.objectContaining({ message: 'factory boom', type: 'Error' }),
        }),
        'Notification error',
      );
      factorySpy.mockRestore();
    });

    it('clearAdapterCache() drops every cached adapter', async () => {
      const n1 = createMockDbNotifier({ id: 1, name: 'W1', events: ['on_grab'] });
      const n2 = createMockDbNotifier({ id: 2, name: 'W2', events: ['on_grab'] });
      db.select.mockReturnValue(mockDbChain([n1, n2]));
      const factorySpy = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockImplementation(() => makeStubAdapter());

      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(2);

      service.clearAdapterCache();
      await service.notify('on_grab', { event: 'on_grab' });
      expect(factorySpy).toHaveBeenCalledTimes(4);
      factorySpy.mockRestore();
    });
  });

  // ── #229 Observability — send log enrichment ────────────────────────────
  describe('logging improvements (#229)', () => {
    it('send logs include notifier name and type at debug', async () => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      await service.notify('on_grab', { event: 'on_grab', book: { title: 'Test' } });

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ notifier: 'Test Webhook', notifierType: 'webhook', event: 'on_grab' }),
        'Notification sent',
      );

      fetchSpy.mockRestore();
    });
  });
});
