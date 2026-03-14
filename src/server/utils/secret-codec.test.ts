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
} from './secret-codec.js';

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

    it('decrypting tampered ciphertext throws', () => {
      const encrypted = encrypt('secret', TEST_KEY);
      const tampered = encrypted.slice(0, 10) + 'X' + encrypted.slice(11);
      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });
  });

  describe('encryptFields / decryptFields', () => {
    it('encryptFields indexer encrypts only apiKey, flareSolverrUrl, mamId', () => {
      const settings = { apiKey: 'my-key', hostname: 'example.com', flareSolverrUrl: 'http://flare', mamId: '12345', pageLimit: 100 };
      const encrypted = encryptFields('indexer', { ...settings }, TEST_KEY);
      expect(isEncrypted(encrypted.apiKey as string)).toBe(true);
      expect(isEncrypted(encrypted.flareSolverrUrl as string)).toBe(true);
      expect(isEncrypted(encrypted.mamId as string)).toBe(true);
      expect(encrypted.hostname).toBe('example.com');
      expect(encrypted.pageLimit).toBe(100);
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

    it('maskFields handles null/undefined fields gracefully', () => {
      const settings = { apiKey: null, hostname: 'example.com' };
      const masked = maskFields('indexer', settings as Record<string, unknown>);
      expect(masked.apiKey).toBe('********');
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
