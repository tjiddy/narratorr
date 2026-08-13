import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotifierService } from './notifier.service.js';
import { mockDbChain, createMockDb, createMockLogger } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, encrypt, isEncrypted } from '../utils/secret-codec.js';
import { ADAPTER_FACTORIES, type NotifierAdapter } from '@core/index.js';

import { createMockDbNotifier } from '../__tests__/factories.js';
import {
  NOTIFIER_BACKOFF_BASE_MS,
  NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES,
  describeNotifierDelivery,
} from './notifier-failure-state.js';

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
  // Hand-driven clock: the #2312 backoff gate is computed arithmetic, so advancing this is
  // both deterministic and the only way to reopen a gate without fake timers.
  let clock: { now: number };

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
    clock = { now: 1_700_000_000_000 };
    service = new NotifierService(db as never, log as never, () => clock.now);
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
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier, mockDiscordNotifier]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      );

      await service.notify('on_grab', {
        event: 'on_grab',
        book: { title: 'Test' },
      });

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

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'on_grab' }),
        'No notifiers configured for event',
      );
      fetchSpy.mockRestore();
    });

    it('#1180 throws a Zod-flavored error naming the missing field when persisted settings are malformed', () => {
      const badNotifier = createMockDbNotifier({ settings: { headers: '{}' } });

      expect(() => service.getAdapter(badNotifier as never)).toThrow(/url/);
    });

    it('resolves without throwing when all matching notifiers fail simultaneously', async () => {
      const notifier1 = createMockDbNotifier({ id: 1, name: 'Webhook 1', events: ['on_grab'] });
      const notifier2 = createMockDbNotifier({ id: 2, name: 'Webhook 2', events: ['on_grab'] });
      const notifier3 = createMockDbNotifier({ id: 3, name: 'Webhook 3', events: ['on_grab'] });
      db.select.mockReturnValue(mockDbChain([notifier1, notifier2, notifier3]));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network down'));

      await service.notify('on_grab', { event: 'on_grab' });

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
      // No SMTP server; reaching the adapter test is sufficient.
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
        expect(debugCalls[entryIdx]![0]).toEqual({ type: 'webhook' });
        expect(debugCalls[exitIdx]![0]).toEqual({ type: 'webhook', success: true, message: undefined });

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

        // Entry precedes adapter creation; only the exit log is absent on this throw.
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

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0] as { settings: Record<string, unknown> };
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

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0] as { settings: Record<string, unknown> };
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

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0] as { settings: Record<string, unknown> };
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
      expect(rows[0]!.settings).toMatchObject({ url: 'https://hook.example.com' });
    });

    it('getById returns decrypted settings', async () => {
      const enc = encrypt('123:abc', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([createMockDbNotifier({ type: 'telegram', settings: { botToken: enc, chatId: '1' } })]));

      const row = await service.getById(1);
      expect(row?.settings).toMatchObject({ botToken: '123:abc', chatId: '1' });
    });

    // #1404: decryption diagnostics must use this service's injected logger.
    it('getById threads this.log: corrupt url warns with entity/failedFields, passthrough preserved', async () => {
      const CORRUPT = '$ENC$not-valid-base64!!'; // $ENC$-prefixed, fails decrypt → passthrough
      db.select.mockReturnValue(mockDbChain([createMockDbNotifier({ type: 'webhook', settings: { url: CORRUPT, method: 'POST' } })]));

      const row = await service.getById(1);

      expect(log.warn).toHaveBeenCalledWith(
        { entity: 'notifier', failedFields: ['url'] },
        expect.stringContaining('secret.key'),
      );
      expect((row!.settings as Record<string, unknown>).url).toBe(CORRUPT);
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

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: Record<string, unknown> };
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

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: Record<string, unknown> };
      expect(isEncrypted(setArg.settings.botToken as string)).toBe(true);
      expect(setArg.settings.botToken).not.toBe(oldEnc);
    });

    it('update rejects sentinel on a non-secret field rather than silently substituting it', async () => {
      const existing = createMockDbNotifier({ type: 'webhook', settings: { url: 'https://hook', method: 'POST' } });
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain([existing]));

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

      // Telegram embeds its bot token in the request path.
      const callUrl = fetchSpy.mock.calls[0]![0] as string;
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
      expect(factorySpy.mock.calls[0]![0]).toMatchObject({ url: 'https://old.hook' });

      const updated = createMockDbNotifier({ id: 1, settings: { url: 'https://new.hook' } });
      db.update.mockReturnValue(mockDbChain([updated]));
      await service.update(1, { settings: { url: 'https://new.hook' } });

      db.select.mockReturnValue(mockDbChain([updated]));
      await service.notify('on_grab', { event: 'on_grab' });

      expect(factorySpy).toHaveBeenCalledTimes(2);
      expect(factorySpy.mock.calls[1]![0]).toMatchObject({ url: 'https://new.hook' });
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

      // Direct access distinguishes eviction from reuse; the cast loosens mocked events typing.
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

      await expect(service.notify('on_grab', { event: 'on_grab' })).resolves.toBeUndefined();
      expect(factorySpy).toHaveBeenCalledTimes(1);

      // A throw with no structural code is transient, so the gate closes for a minute; step
      // past it so this test still measures the cache rather than the backoff.
      clock.now += NOTIFIER_BACKOFF_BASE_MS;
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

  // #2312 — a broken notifier must back off, stop on a terminal failure, and stay observable.
  describe('#2312 delivery state', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    function stubAdapter(send: NotifierAdapter['send']): NotifierAdapter {
      return { type: 'webhook', send, test: vi.fn().mockResolvedValue({ success: true }) };
    }

    /** Route every webhook build through one adapter so send calls are countable. */
    function installAdapter(send: NotifierAdapter['send']) {
      const adapter = stubAdapter(send);
      return vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockReturnValue(adapter);
    }

    const TRANSIENT = { success: false, message: 'HTTP 503', failure: { httpStatus: 503 } };
    const TERMINAL = { success: false, message: 'HTTP 401', failure: { httpStatus: 401 } };
    const OK = { success: true };

    beforeEach(() => {
      db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
    });

    describe('AC8 — transient failures back off and recover', () => {
      it('drops and counts every notification arriving inside the window, then attempts exactly one after it', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        expect(send).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 3; i += 1) await service.notify('on_grab', { event: 'on_grab' });

        expect(send).toHaveBeenCalledTimes(1);
        expect(service.getFailureSnapshot(1).suppressedCount).toBe(3);

        clock.now += NOTIFIER_BACKOFF_BASE_MS;
        await service.notify('on_grab', { event: 'on_grab' });
        expect(send).toHaveBeenCalledTimes(2);

        factory.mockRestore();
      });

      it('surfaces the suppressed count on the health entry once the streak warns', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        for (let i = 0; i < NOTIFIER_WARN_AFTER_CONSECUTIVE_FAILURES; i += 1) {
          clock.now += NOTIFIER_BACKOFF_BASE_MS * 2 ** i;
          await service.notify('on_grab', { event: 'on_grab' });
        }
        await service.notify('on_grab', { event: 'on_grab' });

        const entry = describeNotifierDelivery(service.getFailureSnapshot(1));
        expect(entry.state).toBe('warning');
        expect(entry.message).toContain('1 notification suppressed since');

        factory.mockRestore();
      });

      it('no timer fires a send — nothing is attempted until an event arrives', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        clock.now += 10 * 60 * 60_000;
        await new Promise((r) => setImmediate(r));

        expect(send).toHaveBeenCalledTimes(1);
        factory.mockRestore();
      });

      it('resolves promptly while backing off, leaving no awaited retry ladder', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        await expect(service.notify('on_grab', { event: 'on_grab' })).resolves.toBeUndefined();

        factory.mockRestore();
      });

      it('resets the schedule on the first success, so the next failure starts at the base rung', async () => {
        const send = vi.fn()
          .mockResolvedValueOnce(TRANSIENT)
          .mockResolvedValueOnce(TRANSIENT)
          .mockResolvedValueOnce(OK)
          .mockResolvedValueOnce(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        clock.now += NOTIFIER_BACKOFF_BASE_MS;
        await service.notify('on_grab', { event: 'on_grab' });
        clock.now += NOTIFIER_BACKOFF_BASE_MS * 2;
        await service.notify('on_grab', { event: 'on_grab' });

        expect(service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0, suppressedCount: 0 });

        await service.notify('on_grab', { event: 'on_grab' });
        expect(service.getFailureSnapshot(1).nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS);

        factory.mockRestore();
      });
    });

    describe('AC9 — terminal failures stop and surface', () => {
      it('issues no further attempts, in contrast with the transient case', async () => {
        const send = vi.fn().mockResolvedValue(TERMINAL);
        const factory = installAdapter(send);

        for (let i = 0; i < 6; i += 1) {
          clock.now += 24 * 60 * 60_000;
          await service.notify('on_grab', { event: 'on_grab' });
        }

        expect(send).toHaveBeenCalledTimes(1);
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
        expect(service.getFailureSnapshot(1).suppressedCount).toBe(5);

        factory.mockRestore();
      });

      it('a transient failure over the same span keeps attempting', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        for (let i = 0; i < 6; i += 1) {
          clock.now += 24 * 60 * 60_000;
          await service.notify('on_grab', { event: 'on_grab' });
        }

        expect(send).toHaveBeenCalledTimes(6);
        factory.mockRestore();
      });

      it('promotes a backing-off notifier to stopped and logs the operator reason', async () => {
        const send = vi.fn().mockResolvedValueOnce(TRANSIENT).mockResolvedValueOnce(TERMINAL);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        clock.now += NOTIFIER_BACKOFF_BASE_MS;
        await service.notify('on_grab', { event: 'on_grab' });

        expect(service.getFailureSnapshot(1)).toMatchObject({
          state: 'stopped',
          reason: 'authentication rejected — check credentials',
        });
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ notifier: 'Test Webhook', reason: 'authentication rejected — check credentials' }),
          'Notification failed permanently — delivery stopped',
        );

        factory.mockRestore();
      });

      it('an unclassifiable failure is transient, never terminal', async () => {
        const send = vi.fn().mockResolvedValue({ success: false, message: 'dns exploded' });
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });

        expect(service.getFailureSnapshot(1).state).toBe('backing-off');
        factory.mockRestore();
      });
    });

    describe('races at and around the attempt gate', () => {
      it('ok: two concurrent events both send', async () => {
        const send = vi.fn().mockResolvedValue(OK);
        const factory = installAdapter(send);

        await Promise.all([
          service.notify('on_grab', { event: 'on_grab' }),
          service.notify('on_grab', { event: 'on_grab' }),
        ]);

        expect(send).toHaveBeenCalledTimes(2);
        factory.mockRestore();
      });

      it('backing-off before the gate: zero sends, both suppressed', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        send.mockClear();

        await Promise.all([
          service.notify('on_grab', { event: 'on_grab' }),
          service.notify('on_grab', { event: 'on_grab' }),
        ]);

        expect(send).toHaveBeenCalledTimes(0);
        expect(service.getFailureSnapshot(1).suppressedCount).toBe(2);
        factory.mockRestore();
      });

      it('backing-off at a reopened gate: exactly one send, the loser counted as suppressed', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        send.mockClear();
        clock.now += NOTIFIER_BACKOFF_BASE_MS;

        await Promise.all([
          service.notify('on_grab', { event: 'on_grab' }),
          service.notify('on_grab', { event: 'on_grab' }),
        ]);

        expect(send).toHaveBeenCalledTimes(1);
        expect(service.getFailureSnapshot(1).suppressedCount).toBe(1);
        // Only the winner committed, so the schedule advanced by exactly one rung.
        expect(service.getFailureSnapshot(1).consecutiveFailures).toBe(2);
        expect(service.getFailureSnapshot(1).nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS * 2);

        factory.mockRestore();
      });

      it('stopped: two concurrent events, zero sends, both suppressed', async () => {
        const send = vi.fn().mockResolvedValue(TERMINAL);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        send.mockClear();

        await Promise.all([
          service.notify('on_grab', { event: 'on_grab' }),
          service.notify('on_grab', { event: 'on_grab' }),
        ]);

        expect(send).toHaveBeenCalledTimes(0);
        expect(service.getFailureSnapshot(1).suppressedCount).toBe(2);
        factory.mockRestore();
      });

      it('two concurrent transient outcomes from ok count as two failures', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await Promise.all([
          service.notify('on_grab', { event: 'on_grab' }),
          service.notify('on_grab', { event: 'on_grab' }),
        ]);

        expect(send).toHaveBeenCalledTimes(2);
        expect(service.getFailureSnapshot(1).consecutiveFailures).toBe(2);
        expect(service.getFailureSnapshot(1).nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS * 2);
        factory.mockRestore();
      });
    });

    describe('outcome arbitration from ok — order does not decide severity', () => {
      /** Resolve two concurrent sends in a controlled order rather than by timing. */
      async function raceOutcomes(first: unknown, second: unknown) {
        const a = deferred<never>();
        const b = deferred<never>();
        const send = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const factory = installAdapter(send as unknown as NotifierAdapter['send']);

        const calls = Promise.all([
          service.notify('on_grab', { event: 'on_grab' }),
          service.notify('on_grab', { event: 'on_grab' }),
        ]);
        a.resolve(first as never);
        await new Promise((r) => setImmediate(r));
        b.resolve(second as never);
        await calls;

        factory.mockRestore();
        return service.getFailureSnapshot(1);
      }

      it.each([
        ['terminal then transient', TERMINAL, TRANSIENT],
        ['transient then terminal', TRANSIENT, TERMINAL],
        ['terminal then success', TERMINAL, OK],
        ['success then terminal', OK, TERMINAL],
      ])('%s settles at stopped', async (_label, first, second) => {
        expect((await raceOutcomes(first, second)).state).toBe('stopped');
      });

      it('a success cannot erase a terminal verdict from the health entry', async () => {
        const snapshot = await raceOutcomes(TERMINAL, OK);
        expect(describeNotifierDelivery(snapshot).state).toBe('error');
      });

      it('success then transient leaves a one-failure streak at the first rung', async () => {
        const snapshot = await raceOutcomes(OK, TRANSIENT);
        expect(snapshot).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
        expect(snapshot.nextAttemptAt - clock.now).toBe(NOTIFIER_BACKOFF_BASE_MS);
        expect(describeNotifierDelivery(snapshot).state).toBe('healthy');
      });

      it('transient then success is the recovery reset', async () => {
        const snapshot = await raceOutcomes(TRANSIENT, OK);
        expect(snapshot).toMatchObject({ state: 'ok', consecutiveFailures: 0, suppressedCount: 0 });
        expect(describeNotifierDelivery(snapshot).state).toBe('healthy');
      });
    });

    describe('the failure descriptor stays off the API surface', () => {
      it('test(id) returns only { success, message } for a failed probe', async () => {
        const factory = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockReturnValue({
          type: 'webhook',
          send: vi.fn(),
          test: vi.fn().mockResolvedValue(TERMINAL),
        });

        const result = await service.test(1);

        expect(result).toEqual({ success: false, message: 'HTTP 401' });
        expect(Object.keys(result)).toEqual(['success', 'message']);
        factory.mockRestore();
      });

      it('testConfig() returns only { success, message } for a failed probe', async () => {
        const factory = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockReturnValue({
          type: 'webhook',
          send: vi.fn(),
          test: vi.fn().mockResolvedValue(TERMINAL),
        });

        const result = await service.testConfig({ type: 'webhook', settings: { url: 'https://probe.test' } });

        expect(result).toEqual({ success: false, message: 'HTTP 401' });
        factory.mockRestore();
      });

      it('a probe neither commits an outcome nor clears one', async () => {
        const send = vi.fn().mockResolvedValue(TERMINAL);
        const factory = installAdapter(send);
        await service.notify('on_grab', { event: 'on_grab' });
        factory.mockRestore();

        const probe = vi.spyOn(ADAPTER_FACTORIES, 'webhook').mockReturnValue({
          type: 'webhook',
          send: vi.fn(),
          test: vi.fn().mockResolvedValue(OK),
        });
        await service.test(1);
        probe.mockRestore();

        // Only an AC12 repair leaves `stopped`; a manual probe is not one.
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
      });
    });

    describe('AC13 — a failing notifier never breaks its peers or the caller', () => {
      it('a throwing adapter does not stop the other subscribed notifier receiving', async () => {
        const healthy = vi.fn().mockResolvedValue(OK);
        const second = createMockDbNotifier({ id: 2, name: 'Second', events: ['on_grab'] });
        db.select.mockReturnValue(mockDbChain([mockWebhookNotifier, second]));

        const factory = vi.spyOn(ADAPTER_FACTORIES, 'webhook')
          .mockImplementationOnce(() => stubAdapter(vi.fn().mockRejectedValue(new Error('adapter exploded'))))
          .mockImplementationOnce(() => stubAdapter(healthy));

        await expect(service.notify('on_grab', { event: 'on_grab' })).resolves.toBeUndefined();

        expect(healthy).toHaveBeenCalledTimes(1);
        expect(service.getFailureSnapshot(1).state).toBe('backing-off');
        expect(service.getFailureSnapshot(2).state).toBe('ok');

        factory.mockRestore();
      });
    });

    describe('AC14 — the excluded recipient is dropped before the gate', () => {
      it('sends to the peer, never to the excluded notifier, and leaves its counters untouched', async () => {
        const source = vi.fn().mockResolvedValue(TERMINAL);
        const peer = vi.fn().mockResolvedValue(OK);
        const second = createMockDbNotifier({ id: 2, name: 'Peer', events: ['on_health_issue'] });
        db.select.mockReturnValue(mockDbChain([
          createMockDbNotifier({ id: 1, events: ['on_health_issue'] }),
          second,
        ]));

        const factory = vi.spyOn(ADAPTER_FACTORIES, 'webhook')
          .mockImplementationOnce(() => stubAdapter(peer))
          .mockImplementationOnce(() => stubAdapter(source));

        await service.notify(
          'on_health_issue',
          { event: 'on_health_issue', health: { checkName: 'notifier:Test Webhook', previousState: 'healthy', currentState: 'error' } },
          { excludeNotifierId: 1 },
        );

        expect(source).toHaveBeenCalledTimes(0);
        expect(peer).toHaveBeenCalledTimes(1);
        expect(service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', suppressedCount: 0, consecutiveFailures: 0 });
        expect(service.getFailureSnapshot(2).state).toBe('ok');

        factory.mockRestore();
      });

      it('excluding a backing-off source neither attempts nor counts a suppression', async () => {
        const send = vi.fn().mockResolvedValue(TRANSIENT);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });
        const before = service.getFailureSnapshot(1);
        send.mockClear();

        db.select.mockReturnValue(mockDbChain([createMockDbNotifier({ id: 1, events: ['on_health_issue'] })]));
        for (let i = 0; i < 3; i += 1) {
          await service.notify(
            'on_health_issue',
            { event: 'on_health_issue', health: { checkName: 'notifier:Test Webhook', previousState: 'healthy', currentState: 'warning' } },
            { excludeNotifierId: 1 },
          );
        }

        expect(send).toHaveBeenCalledTimes(0);
        expect(service.getFailureSnapshot(1)).toMatchObject({
          suppressedCount: before.suppressedCount,
          consecutiveFailures: before.consecutiveFailures,
          state: before.state,
        });

        // A real event in the same window still counts, so the figure stays meaningful.
        db.select.mockReturnValue(mockDbChain([mockWebhookNotifier]));
        await service.notify('on_grab', { event: 'on_grab' });
        expect(service.getFailureSnapshot(1).suppressedCount).toBe(before.suppressedCount + 1);

        factory.mockRestore();
      });
    });

    describe('AC10 — the operator\'s enabled column is never written by a system stop', () => {
      it('issues no write of any kind when a terminal failure stops the notifier', async () => {
        const send = vi.fn().mockResolvedValue(TERMINAL);
        const factory = installAdapter(send);

        await service.notify('on_grab', { event: 'on_grab' });

        expect(service.getFailureSnapshot(1).state).toBe('stopped');
        // `enabled` is the operator's intent; a system stop is separate state, so no UPDATE runs.
        expect(db.update).not.toHaveBeenCalled();
        factory.mockRestore();
      });

      it('a fresh service starts clean, so a persistently-broken notifier re-reports after restart', async () => {
        const send = vi.fn().mockResolvedValue(TERMINAL);
        const factory = installAdapter(send);
        await service.notify('on_grab', { event: 'on_grab' });
        expect(service.getFailureSnapshot(1).state).toBe('stopped');

        const restarted = new NotifierService(db as never, log as never, () => clock.now);
        expect(restarted.getFailureSnapshot(1).state).toBe('ok');

        // It re-probes once and immediately re-commits, so nothing stays hidden.
        await restarted.notify('on_grab', { event: 'on_grab' });
        expect(send).toHaveBeenCalledTimes(2);
        expect(restarted.getFailureSnapshot(1).state).toBe('stopped');

        factory.mockRestore();
      });
    });

    describe('AC12 — repairing clears the failure state, renaming does not', () => {
      const STORED = createMockDbNotifier({ id: 1, settings: { url: 'https://example.com/hook' } });

      async function stopIt() {
        const send = vi.fn().mockResolvedValue(TERMINAL);
        const factory = installAdapter(send);
        await service.notify('on_grab', { event: 'on_grab' });
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
        factory.mockRestore();
        return send;
      }

      /** Did the very next notification actually attempt a send? */
      async function attemptsAgain(): Promise<boolean> {
        const send = vi.fn().mockResolvedValue(OK);
        const factory = installAdapter(send);
        await service.notify('on_grab', { event: 'on_grab' });
        factory.mockRestore();
        return send.mock.calls.length > 0;
      }

      beforeEach(() => {
        db.select.mockReturnValue(mockDbChain([STORED]));
        db.update.mockReturnValue(mockDbChain([STORED]));
      });

      it('a settings change clears it and the next notification sends immediately', async () => {
        await stopIt();
        await service.update(1, { settings: { url: 'https://new.hook' } });
        expect(service.getFailureSnapshot(1).state).toBe('ok');
        expect(await attemptsAgain()).toBe(true);
      });

      it('a type change clears it', async () => {
        await stopIt();
        await service.update(1, { type: 'discord' });
        expect(service.getFailureSnapshot(1).state).toBe('ok');
      });

      it('toggling enabled clears it', async () => {
        await stopIt();
        await service.update(1, { enabled: false });
        expect(service.getFailureSnapshot(1).state).toBe('ok');
      });

      it('a rename preserves it — identity is the id, not the display name', async () => {
        await stopIt();
        await service.update(1, { name: 'Renamed' });
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
        expect(await attemptsAgain()).toBe(false);
      });

      it('an events change preserves it', async () => {
        await stopIt();
        await service.update(1, { events: ['on_import'] });
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
      });

      it('a PUT whose resolved values all equal the stored ones preserves it (the ciphertext trap)', async () => {
        await stopIt();
        // A comparison against the encrypted column reports a change every time, because
        // encrypt() re-randomises its IV per call. This row is the only one that catches it.
        await service.update(1, { settings: { url: 'https://example.com/hook' } });
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
        expect(await attemptsAgain()).toBe(false);
      });

      it('a same-value update carrying a masked-secret sentinel preserves it', async () => {
        // The edit form re-submits '********' for `url`; it must resolve to the stored value
        // and therefore compare equal, rather than reading as a repair.
        await stopIt();
        await service.update(1, { settings: { url: '********' } });
        expect(service.getFailureSnapshot(1).state).toBe('stopped');
        expect(await attemptsAgain()).toBe(false);
      });

      it('a sentinel alongside a genuinely changed field still clears it', async () => {
        await stopIt();
        await service.update(1, { settings: { url: '********', method: 'PUT' } });
        expect(service.getFailureSnapshot(1).state).toBe('ok');
      });

      it('delete() prunes the entry so a recreated notifier starts healthy', async () => {
        await stopIt();
        db.delete.mockReturnValue(mockDbChain());
        await service.delete(1);
        expect(service.getFailureSnapshot(1).state).toBe('ok');
      });

      it('clearAdapterCache() drops the failure state too, so no suite leaks it', async () => {
        await stopIt();
        service.clearAdapterCache();
        expect(service.getFailureSnapshot(1).state).toBe('ok');
      });
    });
  });
});
