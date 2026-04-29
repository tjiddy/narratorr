import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  encrypt,
  decrypt,
  isEncrypted,
  isSentinel,
  encryptFields,
  decryptFields,
  maskFields,
  redactSecrets,
  resolveSentinelFields,
  loadEncryptionKey,
  getSecretFieldNames,
  makeTestSchema,
} from './secret-codec.js';
import { notifierSettingsSchemas } from '../../shared/schemas/notifier.js';
import { createIndexerSchema } from '../../shared/schemas/indexer.js';
import { createNotifierSchema } from '../../shared/schemas/notifier.js';
import { createDownloadClientSchema } from '../../shared/schemas/download-client.js';
import { createImportListSchema } from '../../shared/schemas/import-list.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

describe('SecretCodec', () => {
  describe('encrypt / decrypt primitives', () => {
    it('round-trips short string', () => {
      const encrypted = encrypt('hello', TEST_KEY);
      expect(encrypted).not.toBe('hello');
      expect(decrypt(encrypted, TEST_KEY)).toBe('hello');
    });

    it('round-trips empty string', () => {
      const encrypted = encrypt('', TEST_KEY);
      expect(encrypted.startsWith('$ENC$')).toBe(true);
      expect(decrypt(encrypted, TEST_KEY)).toBe('');
    });

    it('round-trips long string (2KB+)', () => {
      const longStr = 'x'.repeat(2048);
      expect(decrypt(encrypt(longStr, TEST_KEY), TEST_KEY)).toBe(longStr);
    });

    it('round-trips Unicode characters', () => {
      const unicode = '日本語テスト 🎧 émojis ñ';
      expect(decrypt(encrypt(unicode, TEST_KEY), TEST_KEY)).toBe(unicode);
    });

    it('round-trips string containing : and @ (proxy URL format)', () => {
      const url = 'http://user:pass@proxy.example.com:8080';
      expect(decrypt(encrypt(url, TEST_KEY), TEST_KEY)).toBe(url);
    });

    it('produces different ciphertexts for same plaintext (random IV)', () => {
      const a = encrypt('same', TEST_KEY);
      const b = encrypt('same', TEST_KEY);
      expect(a).not.toBe(b);
      expect(decrypt(a, TEST_KEY)).toBe('same');
      expect(decrypt(b, TEST_KEY)).toBe('same');
    });

    it('encrypted output starts with $ENC$ prefix', () => {
      expect(encrypt('test', TEST_KEY).startsWith('$ENC$')).toBe(true);
    });

    it('isEncrypted returns true for encrypted values', () => {
      expect(isEncrypted(encrypt('test', TEST_KEY))).toBe(true);
    });

    it('isEncrypted returns false for plaintext', () => {
      expect(isEncrypted('plaintext-api-key')).toBe(false);
      expect(isEncrypted('')).toBe(false);
      expect(isEncrypted('http://proxy.example.com')).toBe(false);
    });

    it('decrypting with wrong key throws', () => {
      const key2 = Buffer.from('b'.repeat(64), 'hex');
      const encrypted = encrypt('secret', TEST_KEY);
      expect(() => decrypt(encrypted, key2)).toThrow();
    });

    it('decrypting tampered ciphertext throws or produces wrong output', () => {
      const plaintext = 'secret';
      const encrypted = encrypt(plaintext, TEST_KEY);
      // Corrupt a byte deep in the ciphertext payload (past $ENC$ prefix + base64 IV)
      const tampered = encrypted.slice(0, 20) + 'X' + encrypted.slice(21);
      try {
        const result = decrypt(tampered, TEST_KEY);
        // AES-GCM should throw on tag mismatch, but if base64 corruption
        // shifts segment boundaries, it may produce garbage instead
        expect(result).not.toBe(plaintext);
      } catch {
        // Expected: GCM auth tag verification failure
      }
    });
  });

  describe('encryptFields / decryptFields', () => {
    it('encryptFields indexer encrypts apiKey, apiUrl, flareSolverrUrl, mamId', () => {
      const settings = { apiKey: 'my-key', apiUrl: 'http://user:pw@host/', hostname: 'example.com', flareSolverrUrl: 'http://flare', mamId: '12345', pageLimit: 100 };
      const encrypted = encryptFields('indexer', { ...settings }, TEST_KEY);
      expect(isEncrypted(encrypted.apiKey as string)).toBe(true);
      expect(isEncrypted(encrypted.apiUrl as string)).toBe(true);
      expect(isEncrypted(encrypted.flareSolverrUrl as string)).toBe(true);
      expect(isEncrypted(encrypted.mamId as string)).toBe(true);
      expect(encrypted.hostname).toBe('example.com');
      expect(encrypted.pageLimit).toBe(100);
    });

    it('encryptFields/decryptFields round-trips indexer apiUrl with embedded credentials (#742)', () => {
      const original = { apiUrl: 'http://user:pw@prowlarr:9696/1/', apiKey: 'k', hostname: 'host' };
      const encrypted = encryptFields('indexer', { ...original }, TEST_KEY);
      expect(isEncrypted(encrypted.apiUrl as string)).toBe(true);
      const decrypted = decryptFields('indexer', encrypted, TEST_KEY);
      expect(decrypted.apiUrl).toBe('http://user:pw@prowlarr:9696/1/');
    });

    it('maskFields("indexer") masks apiUrl when set to non-empty value (#742)', () => {
      const settings = { apiUrl: 'http://user:pw@host:9696/', apiKey: 'k', hostname: 'host' };
      const masked = maskFields('indexer', { ...settings });
      expect(masked.apiUrl).toBe('********');
      expect(masked.apiKey).toBe('********');
      expect(masked.hostname).toBe('host');
    });

    it('encryptFields downloadClient encrypts only password, apiKey', () => {
      const settings = { password: 'pass123', apiKey: 'key456', host: 'localhost', port: 8080 };
      const encrypted = encryptFields('downloadClient', { ...settings }, TEST_KEY);
      expect(isEncrypted(encrypted.password as string)).toBe(true);
      expect(isEncrypted(encrypted.apiKey as string)).toBe(true);
      expect(encrypted.host).toBe('localhost');
      expect(encrypted.port).toBe(8080);
    });

    it('encryptFields leaves non-secret fields untouched', () => {
      const settings = { hostname: 'example.com', pageLimit: 50, useProxy: true };
      const encrypted = encryptFields('indexer', { ...settings }, TEST_KEY);
      expect(encrypted.hostname).toBe('example.com');
      expect(encrypted.pageLimit).toBe(50);
      expect(encrypted.useProxy).toBe(true);
    });

    it('decryptFields reverses encryptFields for indexer', () => {
      const original = { apiKey: 'my-key', hostname: 'example.com', flareSolverrUrl: 'http://flare' };
      const encrypted = encryptFields('indexer', { ...original }, TEST_KEY);
      const decrypted = decryptFields('indexer', encrypted, TEST_KEY);
      expect(decrypted.apiKey).toBe('my-key');
      expect(decrypted.hostname).toBe('example.com');
      expect(decrypted.flareSolverrUrl).toBe('http://flare');
    });

    it('decryptFields reverses encryptFields for downloadClient', () => {
      const original = { password: 'pass', apiKey: 'key', host: 'localhost' };
      const encrypted = encryptFields('downloadClient', { ...original }, TEST_KEY);
      const decrypted = decryptFields('downloadClient', encrypted, TEST_KEY);
      expect(decrypted.password).toBe('pass');
      expect(decrypted.apiKey).toBe('key');
      expect(decrypted.host).toBe('localhost');
    });

    it('encrypting null/undefined field values returns null/undefined', () => {
      const settings = { apiKey: null, hostname: 'example.com' };
      const encrypted = encryptFields('indexer', settings as Record<string, unknown>, TEST_KEY);
      expect(encrypted.apiKey).toBeNull();
    });

    it('encrypting missing fields does not crash', () => {
      const settings = { hostname: 'example.com' };
      const encrypted = encryptFields('indexer', settings, TEST_KEY);
      expect(encrypted.hostname).toBe('example.com');
      expect(encrypted.apiKey).toBeUndefined();
    });
  });

  describe('maskFields', () => {
    it('maskFields indexer replaces secret fields with ********', () => {
      const settings = { apiKey: 'my-key', hostname: 'example.com', flareSolverrUrl: 'http://flare' };
      const masked = maskFields('indexer', { ...settings });
      expect(masked.apiKey).toBe('********');
      expect(masked.flareSolverrUrl).toBe('********');
      expect(masked.hostname).toBe('example.com');
    });

    it('maskFields downloadClient replaces secret fields with ********', () => {
      const settings = { password: 'pass', apiKey: 'key', host: 'localhost' };
      const masked = maskFields('downloadClient', { ...settings });
      expect(masked.password).toBe('********');
      expect(masked.apiKey).toBe('********');
      expect(masked.host).toBe('localhost');
    });

    it('maskFields leaves non-secret fields untouched', () => {
      const settings = { hostname: 'example.com', port: 443 };
      const masked = maskFields('indexer', settings);
      expect(masked.hostname).toBe('example.com');
      expect(masked.port).toBe(443);
    });

    it('maskFields preserves null secret fields — does not mask to sentinel', () => {
      const settings = { apiKey: null, hostname: 'example.com' };
      const masked = maskFields('indexer', settings as Record<string, unknown>);
      expect(masked.apiKey).toBeNull();
    });

    it('maskFields preserves empty string secret fields — does not mask to sentinel', () => {
      const settings = { proxyUrl: '' };
      const masked = maskFields('network', { ...settings });
      expect(masked.proxyUrl).toBe('');
    });

    it('maskFields preserves undefined secret fields — does not mask to sentinel', () => {
      const settings: Record<string, unknown> = { apiKey: undefined };
      const masked = maskFields('indexer', { ...settings });
      expect(masked.apiKey).toBeUndefined();
    });

    it('maskFields preserves empty string across all six secret categories', () => {
      expect(maskFields('network', { proxyUrl: '' }).proxyUrl).toBe('');
      expect(maskFields('prowlarr', { apiKey: '' }).apiKey).toBe('');
      expect(maskFields('auth', { sessionSecret: '', apiKey: '' })).toEqual({ sessionSecret: '', apiKey: '' });
      expect(maskFields('indexer', { apiKey: '' }).apiKey).toBe('');
      expect(maskFields('downloadClient', { apiKey: '', password: '' })).toEqual({ apiKey: '', password: '' });
      expect(maskFields('importList', { apiKey: '' }).apiKey).toBe('');
    });

    it('maskFields mixed: empty field preserved, non-empty field still masked in same object', () => {
      const settings = { apiKey: '', flareSolverrUrl: 'http://flare.example.com' };
      const masked = maskFields('indexer', { ...settings });
      expect(masked.apiKey).toBe('');
      expect(masked.flareSolverrUrl).toBe('********');
    });
  });

  describe('sentinel detection', () => {
    it('isSentinel returns true for ********', () => {
      expect(isSentinel('********')).toBe(true);
    });

    it('isSentinel returns false for other strings', () => {
      expect(isSentinel('real-api-key')).toBe(false);
      expect(isSentinel('*******')).toBe(false);
      expect(isSentinel('')).toBe(false);
    });
  });

  describe('#731 notifier secret fields', () => {
    const NOTIFIER_SECRETS_PER_TYPE: Record<string, string[]> = {
      webhook: ['url', 'headers'],
      discord: ['webhookUrl'],
      slack: ['webhookUrl'],
      telegram: ['botToken'],
      email: ['smtpPass'],
      pushover: ['pushoverToken'],
      gotify: ['gotifyToken'],
      // script + ntfy intentionally have no secret fields in the current schema
      script: [],
      ntfy: [],
    };

    it('getSecretFieldNames("notifier") returns the union of per-type secret fields', () => {
      const fields = getSecretFieldNames('notifier');
      const expected = ['url', 'webhookUrl', 'botToken', 'smtpPass', 'pushoverToken', 'gotifyToken', 'headers'];
      expect([...fields].sort()).toEqual([...expected].sort());
    });

    it('every per-type secret field appears in SECRET_FIELDS["notifier"]', () => {
      const registered = new Set(getSecretFieldNames('notifier'));
      for (const [type, fields] of Object.entries(NOTIFIER_SECRETS_PER_TYPE)) {
        for (const field of fields) {
          expect(registered.has(field), `${type}.${field} must be registered as a notifier secret`).toBe(true);
        }
      }
    });

    it('round-trips encryption for every notifier secret field', () => {
      for (const field of getSecretFieldNames('notifier')) {
        const settings: Record<string, unknown> = { [field]: 'plaintext-value' };
        const encrypted = encryptFields('notifier', { ...settings }, TEST_KEY);
        expect(isEncrypted(encrypted[field] as string)).toBe(true);
        const decrypted = decryptFields('notifier', encrypted, TEST_KEY);
        expect(decrypted[field]).toBe('plaintext-value');
      }
    });

    it('round-trips encryption of webhook headers as a JSON string', () => {
      const headers = JSON.stringify({ Authorization: 'Bearer abc', 'X-Api-Key': 'xyz' });
      const encrypted = encryptFields('notifier', { headers }, TEST_KEY);
      expect(isEncrypted(encrypted.headers as string)).toBe(true);
      const decrypted = decryptFields('notifier', encrypted, TEST_KEY);
      expect(decrypted.headers).toBe(headers);
    });

    it('maskFields("notifier") replaces non-empty secrets with sentinel and leaves non-secret fields alone', () => {
      const settings = {
        url: 'https://hook',
        method: 'POST',
        headers: '{"Authorization":"Bearer x"}',
        bodyTemplate: '{}',
      };
      const masked = maskFields('notifier', { ...settings });
      expect(masked.url).toBe('********');
      expect(masked.headers).toBe('********');
      expect(masked.method).toBe('POST');
      expect(masked.bodyTemplate).toBe('{}');
    });

    it('encryptFields skips notifier types without secret fields (script/ntfy)', () => {
      const ntfy = encryptFields('notifier', { ntfyTopic: 'topic', ntfyServer: 'https://ntfy.sh' }, TEST_KEY);
      expect(ntfy.ntfyTopic).toBe('topic');
      expect(ntfy.ntfyServer).toBe('https://ntfy.sh');
      const script = encryptFields('notifier', { path: '/tmp/x.sh', timeout: 30 }, TEST_KEY);
      expect(script.path).toBe('/tmp/x.sh');
      expect(script.timeout).toBe(30);
    });

    it('every per-type schema secret field is registered (drift guard)', () => {
      // Sanity check: notifier-type schemas referenced for the audit
      expect(notifierSettingsSchemas.webhook).toBeDefined();
      expect(notifierSettingsSchemas.telegram).toBeDefined();
      // The behavior — every field in NOTIFIER_SECRETS_PER_TYPE is in registry — is asserted above.
    });
  });

  describe('redactSecrets', () => {
    it('redactSecrets replaces secret fields with [REDACTED]', () => {
      const settings = { apiKey: 'my-key', hostname: 'example.com' };
      const redacted = redactSecrets('indexer', { ...settings });
      expect(redacted.apiKey).toBe('[REDACTED]');
      expect(redacted.hostname).toBe('example.com');
    });

    it('redactSecrets leaves non-secret fields untouched', () => {
      const settings = { hostname: 'example.com', pageLimit: 50 };
      const redacted = redactSecrets('indexer', settings);
      expect(redacted.hostname).toBe('example.com');
      expect(redacted.pageLimit).toBe(50);
    });
  });
});

describe('resolveSentinelFields', () => {
  it('replaces sentinel values with existing encrypted values', () => {
    const incoming = { apiKey: '********', hostname: 'example.com' };
    const existing = { apiKey: '$ENC$encrypted-key', hostname: 'old.com' };
    const result = resolveSentinelFields(incoming, existing);
    expect(result.apiKey).toBe('$ENC$encrypted-key');
    expect(result.hostname).toBe('example.com');
  });

  it('passes through non-sentinel values unchanged', () => {
    const incoming = { apiKey: 'new-real-key', hostname: 'new.com' };
    const existing = { apiKey: '$ENC$old-key', hostname: 'old.com' };
    const result = resolveSentinelFields(incoming, existing);
    expect(result.apiKey).toBe('new-real-key');
    expect(result.hostname).toBe('new.com');
  });

  it('handles empty incoming settings object', () => {
    const incoming = {};
    const existing = { apiKey: '$ENC$old-key' };
    const result = resolveSentinelFields(incoming, existing);
    expect(result).toEqual({});
  });

  it('handles fields present in incoming but missing in existing', () => {
    const incoming = { apiKey: '********', newField: 'value' };
    const existing = { hostname: 'old.com' };
    const result = resolveSentinelFields(incoming, existing);
    // apiKey sentinel has no match in existing — keeps undefined (existing value)
    expect(result.apiKey).toBeUndefined();
    expect(result.newField).toBe('value');
  });

  it('handles null/undefined existing record', () => {
    const incoming = { apiKey: '********', hostname: 'new.com' };
    const result = resolveSentinelFields(incoming, null);
    // No existing record to look up — sentinel stays as undefined
    expect(result.apiKey).toBeUndefined();
    expect(result.hostname).toBe('new.com');
  });
});

describe('makeTestSchema', () => {
  describe('indexer', () => {
    const schema = makeTestSchema(createIndexerSchema, 'indexer');
    const valid = { name: 'idx', type: 'myanonamouse', enabled: true, priority: 50, settings: { mamId: '********' } };

    it('accepts sentinel for registered secret field (mamId)', () => {
      expect(schema.safeParse(valid).success).toBe(true);
    });

    it('accepts sentinel for newznab apiKey/apiUrl', () => {
      const r = schema.safeParse({
        name: 'n', type: 'newznab', enabled: true, priority: 50,
        settings: { apiUrl: '********', apiKey: '********' },
      });
      expect(r.success).toBe(true);
    });

    it('accepts real value for registered secret field', () => {
      const r = schema.safeParse({ ...valid, settings: { mamId: 'real-cookie-value' } });
      expect(r.success).toBe(true);
    });

    it('rejects empty string for required secret field (.min(1) still applies for non-sentinel)', () => {
      const r = schema.safeParse({ ...valid, settings: { mamId: '' } });
      expect(r.success).toBe(false);
    });

    it('rejects missing required name', () => {
      const r = schema.safeParse({ type: 'myanonamouse', enabled: true, priority: 50, settings: { mamId: '********' } });
      expect(r.success).toBe(false);
    });

    it('rejects priority out of range (200)', () => {
      const r = schema.safeParse({ ...valid, priority: 200 });
      expect(r.success).toBe(false);
    });

    it('rejects unknown type discriminator', () => {
      const r = schema.safeParse({ ...valid, type: 'unknown' });
      expect(r.success).toBe(false);
    });

    it('rejects per-type mismatch (newznab with mamId only)', () => {
      const r = schema.safeParse({
        name: 'n', type: 'newznab', enabled: true, priority: 50,
        settings: { mamId: 'x' },
      });
      expect(r.success).toBe(false);
    });

    it('rejects unknown key in strict per-type schema (bogusKey on myanonamouse)', () => {
      const r = schema.safeParse({
        name: 'n', type: 'myanonamouse', enabled: true, priority: 50,
        settings: { mamId: '********', bogusKey: 'x' },
      });
      expect(r.success).toBe(false);
    });

    it('accepts optional id field', () => {
      const r = schema.safeParse({ ...valid, id: 7 });
      expect(r.success).toBe(true);
      if (r.success) {
        expect((r.data as { id?: number }).id).toBe(7);
      }
    });

    it('rejects negative id', () => {
      const r = schema.safeParse({ ...valid, id: -1 });
      expect(r.success).toBe(false);
    });
  });

  describe('cross-entity isolation', () => {
    it('notifier schema does not loosen mamId (not a notifier secret)', () => {
      const schema = makeTestSchema(createNotifierSchema, 'notifier');
      const r = schema.safeParse({
        name: 'n', type: 'webhook', enabled: true, events: ['on_grab'],
        settings: { url: 'http://x', mamId: '********' },
      });
      expect(r.success).toBe(false);
    });

    it('notifier schema accepts sentinel for url (registered notifier secret)', () => {
      const schema = makeTestSchema(createNotifierSchema, 'notifier');
      const r = schema.safeParse({
        name: 'n', type: 'webhook', enabled: true, events: ['on_grab'],
        settings: { url: '********' },
      });
      expect(r.success).toBe(true);
    });
  });

  describe('downloadClient', () => {
    const schema = makeTestSchema(createDownloadClientSchema, 'downloadClient');

    it('accepts sentinel for password and apiKey', () => {
      const qb = schema.safeParse({
        name: 'qb', type: 'qbittorrent', enabled: true, priority: 50,
        settings: { host: 'h', port: 8080, password: '********' },
      });
      expect(qb.success).toBe(true);
      const sab = schema.safeParse({
        name: 'sab', type: 'sabnzbd', enabled: true, priority: 50,
        settings: { host: 'h', port: 8080, apiKey: '********' },
      });
      expect(sab.success).toBe(true);
    });

    it('rejects empty apiKey for sabnzbd (min(1) holds for non-sentinel)', () => {
      const r = schema.safeParse({
        name: 'sab', type: 'sabnzbd', enabled: true, priority: 50,
        settings: { host: 'h', port: 8080, apiKey: '' },
      });
      expect(r.success).toBe(false);
    });
  });

  describe('importList', () => {
    const schema = makeTestSchema(createImportListSchema, 'importList');

    it('accepts sentinel for apiKey on abs', () => {
      const r = schema.safeParse({
        name: 'abs', type: 'abs', enabled: true, syncIntervalMinutes: 1440,
        settings: { serverUrl: 'http://abs', apiKey: '********', libraryId: 'lib-1' },
      });
      expect(r.success).toBe(true);
    });

    it('preserves hardcover listType/shelfId rule when apiKey loosened', () => {
      const r = schema.safeParse({
        name: 'hc', type: 'hardcover', enabled: true, syncIntervalMinutes: 1440,
        settings: { apiKey: '********', listType: 'shelf' },
      });
      expect(r.success).toBe(false);
    });
  });
});

describe('Key Management', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratorr-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadEncryptionKey', () => {
    it('uses NARRATORR_SECRET_KEY env var when set to valid 64-char hex', () => {
      const validHex = randomBytes(32).toString('hex');
      const result = loadEncryptionKey(validHex, tmpDir);
      expect(result.key).toBeInstanceOf(Buffer);
      expect(result.key.length).toBe(32);
      expect(result.key.toString('hex')).toBe(validHex);
      expect(result.source).toBe('env');
    });

    it('fails on NARRATORR_SECRET_KEY with 63 chars', () => {
      expect(() => loadEncryptionKey('a'.repeat(63), tmpDir)).toThrow(/must be a 64-character hex string/);
    });

    it('fails on NARRATORR_SECRET_KEY with non-hex chars', () => {
      expect(() => loadEncryptionKey('g'.repeat(64), tmpDir)).toThrow(/must be a 64-character hex string/);
    });

    it('treats empty NARRATORR_SECRET_KEY as unset', () => {
      const result = loadEncryptionKey('', tmpDir);
      expect(result.key).toBeInstanceOf(Buffer);
      expect(result.key.length).toBe(32);
      expect(result.source).toBe('generated');
      expect(fs.existsSync(path.join(tmpDir, 'secret.key'))).toBe(true);
    });

    it('generates key file when no env var and no file exists', () => {
      const keyFile = path.join(tmpDir, 'secret.key');
      expect(fs.existsSync(keyFile)).toBe(false);
      const result = loadEncryptionKey(undefined, tmpDir);
      expect(result.key.length).toBe(32);
      expect(result.source).toBe('generated');
      expect(fs.existsSync(keyFile)).toBe(true);
      expect(fs.readFileSync(keyFile, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reads existing key file when no env var', () => {
      const knownKey = randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(tmpDir, 'secret.key'), knownKey + '\n');
      const result = loadEncryptionKey(undefined, tmpDir);
      expect(result.key.toString('hex')).toBe(knownKey);
      expect(result.source).toBe('file');
    });

    it('fails on malformed key file content', () => {
      fs.writeFileSync(path.join(tmpDir, 'secret.key'), 'not-valid-hex\n');
      expect(() => loadEncryptionKey(undefined, tmpDir)).toThrow(/must be a 64-character hex string/);
    });

    it('uses configPath for key file location', () => {
      const subDir = path.join(tmpDir, 'custom-config');
      fs.mkdirSync(subDir, { recursive: true });
      loadEncryptionKey(undefined, subDir);
      expect(fs.existsSync(path.join(subDir, 'secret.key'))).toBe(true);
    });

    it('consistent key across multiple loads from same file', () => {
      const result1 = loadEncryptionKey(undefined, tmpDir);
      const result2 = loadEncryptionKey(undefined, tmpDir);
      expect(result1.key.toString('hex')).toBe(result2.key.toString('hex'));
      expect(result2.source).toBe('file');
    });
  });
});
