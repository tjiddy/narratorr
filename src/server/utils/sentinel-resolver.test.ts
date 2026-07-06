import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  resolveAndEncryptSettings,
  resolveSettings,
} from './sentinel-resolver.js';
import {
  encrypt,
  decrypt,
  isEncrypted,
  isSentinel,
  initializeKey,
  getKey,
  _resetKey,
  SentinelOnNonSecretFieldError,
} from './secret-codec.js';

const SENTINEL = '********';

describe('service-side sentinel helpers', () => {
  let key: Buffer;

  beforeEach(() => {
    key = randomBytes(32);
    initializeKey(key);
  });

  afterEach(() => {
    _resetKey();
  });

  describe('resolveAndEncryptSettings', () => {
    it('resolves a sentinel on an allowed secret key to the stored (encrypted) bytes, which encryptFields leaves untouched', () => {
      const stored = encrypt('super-secret', getKey());
      const existing = { apiKey: stored, apiUrl: 'https://prowlarr.local' };
      const incoming = { apiKey: SENTINEL, apiUrl: 'https://prowlarr.local' };

      const result = resolveAndEncryptSettings('indexer', incoming, existing);

      // Sentinel resolved to the exact stored ciphertext; encryptFields skipped it.
      expect(result.apiKey).toBe(stored);
      expect(decrypt(result.apiKey as string, key)).toBe('super-secret');
    });

    it('throws SentinelOnNonSecretFieldError for a sentinel on a non-secret key', () => {
      const existing = { apiKey: encrypt('k', getKey()) };
      const incoming = { hostname: SENTINEL };

      expect(() => resolveAndEncryptSettings('indexer', incoming, existing)).toThrow(
        SentinelOnNonSecretFieldError,
      );
    });

    it('encrypts a newly-provided plaintext secret value', () => {
      const result = resolveAndEncryptSettings('indexer', { apiKey: 'brand-new-key' }, {});

      expect(isEncrypted(result.apiKey as string)).toBe(true);
      expect(decrypt(result.apiKey as string, key)).toBe('brand-new-key');
    });

    it('tolerates null/undefined existing — a sentinel resolves to undefined', () => {
      const resultNull = resolveAndEncryptSettings('indexer', { apiKey: SENTINEL }, null);
      expect(resultNull.apiKey).toBeUndefined();

      const resultUndef = resolveAndEncryptSettings('indexer', { apiKey: SENTINEL }, undefined);
      expect(resultUndef.apiKey).toBeUndefined();
    });

    it('does not mutate the caller-provided incoming object', () => {
      const stored = encrypt('secret', getKey());
      const incoming = { apiKey: SENTINEL };

      const result = resolveAndEncryptSettings('indexer', incoming, { apiKey: stored });

      expect(incoming.apiKey).toBe(SENTINEL); // caller's object untouched
      expect(result).not.toBe(incoming);
      expect(result.apiKey).toBe(stored);
    });

    it('respects the per-entity allowlist — a key secret for one entity is non-secret for another', () => {
      // `apiUrl` is a secret field for `indexer` but not for `downloadClient`.
      const existing = { apiUrl: encrypt('https://x', getKey()) };

      expect(() => resolveAndEncryptSettings('indexer', { apiUrl: SENTINEL }, existing)).not.toThrow();
      expect(() => resolveAndEncryptSettings('downloadClient', { apiUrl: SENTINEL }, existing)).toThrow(
        SentinelOnNonSecretFieldError,
      );
    });

    it('resolves against a value-column-style object (settings.service variant)', () => {
      // settings.service passes the `value` column object directly as `existing`.
      const stored = encrypt('hc-key', getKey());
      const result = resolveAndEncryptSettings('metadata', { hardcoverApiKey: SENTINEL }, { hardcoverApiKey: stored });

      expect(result.hardcoverApiKey).toBe(stored);
      expect(decrypt(result.hardcoverApiKey as string, key)).toBe('hc-key');
    });
  });

  describe('resolveSettings (resolve-only)', () => {
    it('resolves a sentinel on an allowed key to the decrypted plaintext, without encrypting', () => {
      const existing = { apiKey: 'plaintext-secret', hostname: 'idx.local' };
      const incoming = { apiKey: SENTINEL, hostname: 'idx.local' };

      const result = resolveSettings('indexer', incoming, existing);

      expect(result.apiKey).toBe('plaintext-secret');
      expect(isEncrypted(result.apiKey as string)).toBe(false);
      expect(isSentinel(result.apiKey as string)).toBe(false);
    });

    it('throws SentinelOnNonSecretFieldError for a sentinel on a disallowed key', () => {
      expect(() => resolveSettings('indexer', { hostname: SENTINEL }, { hostname: 'x' })).toThrow(
        SentinelOnNonSecretFieldError,
      );
    });

    it('returns settings unchanged when no sentinels are present', () => {
      const incoming = { apiKey: 'literal', hostname: 'idx.local' };

      const result = resolveSettings('indexer', incoming, { apiKey: 'stored' });

      expect(result).toEqual(incoming);
      expect(result).not.toBe(incoming); // still a fresh clone
    });

    it('does not mutate the caller-provided incoming object', () => {
      const incoming = { apiKey: SENTINEL };
      resolveSettings('indexer', incoming, { apiKey: 'plain' });
      expect(incoming.apiKey).toBe(SENTINEL);
    });
  });
});
