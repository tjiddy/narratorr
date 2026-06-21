import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { indexers } from '../../db/schema.js';
import { encrypt, isEncrypted } from './secret-codec.js';
import { migrateSecretsToEncrypted } from './secret-migration.js';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(actual.eq),
  };
});

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
    vi.mocked(eq).mockClear();
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
      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
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

      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
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

      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
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

    // #1567: the migration list previously omitted earwitness (the #1526 drift) —
    // a plaintext earwitness.apiKey row must now be encrypted by the backfill.
    it('#1567 encrypts plaintext earwitness.apiKey on startup', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([])); // notifiers
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('earwitness', { enabled: true, baseUrl: 'https://host', apiKey: 'ew-plain-key' }),
      ]));
      db.insert.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.insert).toHaveBeenCalled();
      const insertChain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = insertChain.values.mock.calls[0]![0]!.value;
      expect(isEncrypted(storedValue.apiKey as string)).toBe(true);
      // baseUrl is NOT a secret for earwitness — stored verbatim
      expect(storedValue.baseUrl).toBe('https://host');
      expect(storedValue.enabled).toBe(true);
    });

    // F2 (PR #1135 review): startup encryption loop covers metadata.hardcoverApiKey
    it('#1133 encrypts plaintext metadata.hardcoverApiKey on startup', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([])); // notifiers
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('metadata', { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: 'sk-plain-1234' }),
      ]));
      db.insert.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      // The settings upsert is the FIRST insert call (no indexer/download/notifier updates happened).
      const insertChain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = insertChain.values.mock.calls[0]![0]!.value;
      expect(isEncrypted(storedValue.hardcoverApiKey as string)).toBe(true);
      // Non-secret metadata fields pass through unchanged
      expect(storedValue.audibleRegion).toBe('us');
      expect(storedValue.languages).toEqual(['english']);
      expect(storedValue.minDurationMinutes).toBe(0);
    });

    it('#1133 idempotent — already-encrypted metadata.hardcoverApiKey is not re-encrypted', async () => {
      const alreadyEncrypted = encrypt('sk-stable-2222', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([])); // notifiers
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('metadata', { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: alreadyEncrypted }),
      ]));

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('#1133 skips the metadata row entirely when hardcoverApiKey is empty (no churn for default install)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([])); // notifiers
      db.select.mockReturnValueOnce(mockDbChain([
        createSettingsRow('metadata', { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: '' }),
      ]));

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.insert).not.toHaveBeenCalled();
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

      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
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

    it('#1307 encrypts plaintext pushoverUser and ntfyTopic on startup', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { pushoverToken: 'tok', pushoverUser: 'u-abc' } },
        { id: 2, settings: { ntfyTopic: 't-xyz', ntfyServer: 'https://ntfy.sh' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([])); // settings
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(2);
      // mockReturnValue hands back one shared chain, so both .set() calls land on it.
      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
      const pushoverSettings = setCalls[0][0].settings;
      expect(isEncrypted(pushoverSettings.pushoverToken)).toBe(true);
      expect(isEncrypted(pushoverSettings.pushoverUser)).toBe(true);
      const ntfySettings = setCalls[1][0].settings;
      expect(isEncrypted(ntfySettings.ntfyTopic)).toBe(true);
      // Non-secret sibling stays plaintext
      expect(ntfySettings.ntfyServer).toBe('https://ntfy.sh');
    });

    it('#1307 idempotent — already-encrypted pushoverUser/ntfyTopic are not re-written', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { pushoverToken: encrypt('tok', TEST_KEY), pushoverUser: encrypt('u-abc', TEST_KEY) } },
        { id: 2, settings: { ntfyTopic: encrypt('t-xyz', TEST_KEY), ntfyServer: 'https://ntfy.sh' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([])); // settings

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).not.toHaveBeenCalled();
    });

    it('#1357 realistic upgrade row: pushoverToken already $ENC$, pushoverUser plaintext — only pushoverUser is rewritten, token ciphertext byte-identical', async () => {
      // The universal post-#731 upgrade state: a row whose token was encrypted by
      // the prior build but whose user key is still plaintext. Encrypting the
      // sibling must NOT touch the already-encrypted token (idempotent skip via
      // isEncrypted) — the token ciphertext must come back byte-for-byte identical.
      const tokenCiphertext = encrypt('po-token', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([])); // indexers
      db.select.mockReturnValueOnce(mockDbChain([])); // downloadClients
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { pushoverToken: tokenCiphertext, pushoverUser: 'u-plaintext' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([])); // settings
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
      const updatedSettings = setCalls[0][0].settings;
      // The plaintext user key is now encrypted...
      expect(isEncrypted(updatedSettings.pushoverUser)).toBe(true);
      // ...and the pre-encrypted token is untouched, byte-identical to the seed.
      expect(updatedSettings.pushoverToken).toBe(tokenCiphertext);
    });

    it('#811 encrypts plaintext apiUrl alone in indexer settings', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiUrl: 'http://example.com/api' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
      const updatedSettings = setCalls[0][0].settings;
      expect(isEncrypted(updatedSettings.apiUrl)).toBe(true);

      expect(db.update.mock.results[0]!.value.where).toHaveBeenCalledTimes(1);
      expect(eq).toHaveBeenCalledWith(indexers.id, 1);
    });

    it('#811 encrypts both apiKey and apiUrl in the same indexer', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiKey: 'plain-key', apiUrl: 'http://example.com/api' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
      const updatedSettings = setCalls[0][0].settings;
      expect(isEncrypted(updatedSettings.apiKey)).toBe(true);
      expect(isEncrypted(updatedSettings.apiUrl)).toBe(true);
    });

    it('#811 idempotent — already-encrypted apiUrl is not re-encrypted', async () => {
      const alreadyEncrypted = encrypt('http://example.com/api', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiUrl: alreadyEncrypted } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).not.toHaveBeenCalled();
    });

    it('#811 indexer with no registered secret fields does not trigger update', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { hostname: 'example.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      await expect(
        migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log)),
      ).resolves.not.toThrow();

      expect(db.update).not.toHaveBeenCalled();
    });

    it('#811 sibling plaintext secret without apiUrl does not synthesize apiUrl', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { mamId: 'plain', hostname: 'mam.example.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
      const updatedSettings = setCalls[0][0].settings;
      expect(isEncrypted(updatedSettings.mamId)).toBe(true);
      expect('apiUrl' in updatedSettings).toBe(false);
    });

    it('#811 mixed roster — only the plaintext apiUrl row is updated', async () => {
      const alreadyEncrypted = encrypt('http://b.com/api', TEST_KEY);
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, settings: { apiUrl: 'http://a.com/api' } },
        { id: 2, settings: { apiUrl: alreadyEncrypted } },
        { id: 3, settings: { hostname: 'c.com' } },
      ]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain());

      await migrateSecretsToEncrypted(inject<Db>(db), TEST_KEY, inject<FastifyBaseLogger>(log));

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCalls = db.update.mock.results[0]!.value.set.mock.calls;
      const updatedSettings = setCalls[0][0].settings;
      expect(isEncrypted(updatedSettings.apiUrl)).toBe(true);

      expect(db.update.mock.results[0]!.value.where).toHaveBeenCalledTimes(1);
      expect(eq).toHaveBeenCalledTimes(1);
      expect(eq).toHaveBeenCalledWith(indexers.id, 1);
      expect(eq).not.toHaveBeenCalledWith(indexers.id, 2);
      expect(eq).not.toHaveBeenCalledWith(indexers.id, 3);
    });
  });
});
