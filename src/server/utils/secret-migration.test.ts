import { describe, it, expect, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { encrypt, isEncrypted } from './secret-codec.js';
import { migrateSecretsToEncrypted } from './secret-migration.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

function createSettingsRow(key: string, value: unknown) {
  return { key, value };
}

describe('Secret Migration', () => {
  let db: Record<'select' | 'insert' | 'update' | 'delete', Mock>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
  });

  describe('migrateSecretsToEncrypted', () => {
    it('encrypts plaintext apiKey in indexer settings', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiKey: 'plain-key', hostname: 'example.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalled();
      const setCalls = db.update.mock.results[0].value.set.mock.calls;
      expect(setCalls.length).toBeGreaterThan(0);
      const updatedSettings = setCalls[0][0].settings;
      expect(isEncrypted(updatedSettings.apiKey)).toBe(true);
      expect(updatedSettings.hostname).toBe('example.com');
    });

    it('encrypts mixed indexers (some with apiKey, some without)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiKey: 'key1', hostname: 'a.com' } },
        { id: 2, settings: { hostname: 'b.com' } },
        { id: 3, settings: { apiKey: 'key3', hostname: 'c.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(2);
    });

    it('encrypts apiKey + flareSolverrUrl in same indexer', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiKey: 'key', flareSolverrUrl: 'http://flare:8191', hostname: 'h.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      const setCalls = db.update.mock.results[0].value.set.mock.calls;
      const settings = setCalls[0][0].settings;
      expect(isEncrypted(settings.apiKey)).toBe(true);
      expect(isEncrypted(settings.flareSolverrUrl)).toBe(true);
      expect(settings.hostname).toBe('h.com');
    });

    it('encrypts download client password + apiKey', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { password: 'pass', apiKey: 'key', host: 'localhost' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      const setCalls = db.update.mock.results[0].value.set.mock.calls;
      const settings = setCalls[0][0].settings;
      expect(isEncrypted(settings.password)).toBe(true);
      expect(isEncrypted(settings.apiKey)).toBe(true);
      expect(settings.host).toBe('localhost');
    });

    it('encrypts network proxy URL', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('network', { proxyUrl: 'http://user:pass@proxy:8080', timeout: 30 }),
      ]));
      db.insert.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.insert).toHaveBeenCalled();
    });

    it('encrypts prowlarr config apiKey', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('prowlarr', { url: 'http://prowlarr', apiKey: 'prowlarr-key' }),
      ]));
      db.insert.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.insert).toHaveBeenCalled();
    });

    it('encrypts auth sessionSecret + apiKey', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('auth', { mode: 'password', apiKey: 'uuid-key', sessionSecret: 'hex-secret', localBypass: false }),
      ]));
      db.insert.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.insert).toHaveBeenCalled();
    });

    it('skips already-encrypted values ($ENC$ prefix)', async () => {
      const alreadyEncrypted = encrypt('original-key', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiKey: alreadyEncrypted, hostname: 'example.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).not.toHaveBeenCalled();
    });

    it('handles missing/empty secret fields without crash', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { hostname: 'example.com' } },
        { id: 2, settings: {} },
        { id: 3, settings: { apiKey: null } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      await expect(
        migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log)),
      ).resolves.not.toThrow();
    });

    it('logs record count but not secret values', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiKey: 'secret-key-value' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { password: 'secret-pass-value' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      const allLogOutput = JSON.stringify((log.info as Mock).mock.calls);
      expect(allLogOutput).not.toContain('secret-key-value');
      expect(allLogOutput).not.toContain('secret-pass-value');
      expect((log.info as Mock).mock.calls.length).toBeGreaterThan(0);
    });

    it('#731 encrypts notifier webhook url + headers', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { url: 'https://hook.example.com', headers: '{"Authorization":"Bearer x"}', method: 'POST' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      const setCalls = db.update.mock.results[0].value.set.mock.calls;
      const settings = setCalls[0][0].settings;
      expect(isEncrypted(settings.url)).toBe(true);
      expect(isEncrypted(settings.headers)).toBe(true);
      expect(settings.method).toBe('POST');
    });

    it('#731 encrypts notifier secrets across multiple types', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { webhookUrl: 'https://discord.com/api/webhooks/1/xyz' } },
        { id: 2, settings: { botToken: '123:secret', chatId: '-100' } },
        { id: 3, settings: { smtpHost: 'smtp.test', smtpPass: 'pw', fromAddress: 'a@b.c', toAddress: 'c@d.e' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(3);
    });

    it('#731 idempotent — skips notifier rows already in $ENC$ form', async () => {
      const enc = encrypt('https://hook', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { url: enc, method: 'POST' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).not.toHaveBeenCalled();
    });

    it('#731 mixed plaintext + encrypted notifiers — only plaintext re-encrypted', async () => {
      const enc = encrypt('https://already-encrypted', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { url: enc } },
        { id: 2, settings: { url: 'https://still-plaintext' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });
});
