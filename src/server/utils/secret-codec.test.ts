import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
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
  SentinelOnNonSecretFieldError,
  loadEncryptionKey,
  getSecretFieldNames,
  makeTestSchema,
  loosenSettingsSchemas,
} from './secret-codec.js';
import { notifierSettingsSchemas } from '../../shared/schemas/notifier.js';

// Heuristic for detecting secret-shaped notifier field names. Today's 10
// registered notifier secrets all match: `url`, `webhookUrl`, `headers`,
// `*Token` (botToken / pushoverToken / gotifyToken / ntfyAccessToken),
// `*Pass` (smtpPass),
// `*User` (pushoverUser), `*Topic` (ntfyTopic). The `*User` / `*Topic` suffixes
// were added in #1307; the `*Key` / `*Secret` / `*Password` suffixes were added
// in #1357 (anticipatory widening — every other SECRET_FIELDS entity already
// uses `apiKey`-shaped names, so the next unregistered credential of any of
// these shapes is caught by the drift guard rather than silently stored
// plaintext, at zero denylist cost since no current field matches them).
// Non-secret notifier fields (gotifyUrl, ntfyServer, smtpHost, chatId,
// fromAddress, toAddress, path, method, bodyTemplate, etc.) do NOT match — the
// `^url$` and `^webhookUrl$` alternatives are anchored, so `gotifyUrl` /
// `ntfyServer` slip past, and the suffix rules only catch the suffix shape.
// `email.smtpUser` is the one genuine false positive (an SMTP username, not a
// credential — unlike smtpPass), so it lives in the explicit denylist below.
// The denylist is keyed by `${type}.${field}` (#1357), not the bare field name:
// exempting `smtpUser` globally would also silently skip a future non-email type
// that reused `smtpUser`-shaped naming for a real secret. Add to the denylist
// only when a non-secret `${type}.${field}` genuinely matches this heuristic.
const NOTIFIER_SECRET_NAME_HEURISTIC = /^(url|webhookUrl|headers|.*Token|.*Pass|.*User|.*Topic|.*Key|.*Secret|.*Password)$/;
const NOTIFIER_SECRET_HEURISTIC_FALSE_POSITIVES = new Set(['email.smtpUser']);

function findSecretShapedNotifierFields(
  schemas: Record<string, z.ZodTypeAny>,
): Array<{ type: string; field: string }> {
  const found: Array<{ type: string; field: string }> = [];
  for (const [type, schema] of Object.entries(schemas)) {
    if (!(schema instanceof z.ZodObject)) continue;
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    for (const field of Object.keys(shape)) {
      if (NOTIFIER_SECRET_NAME_HEURISTIC.test(field) && !NOTIFIER_SECRET_HEURISTIC_FALSE_POSITIVES.has(`${type}.${field}`)) {
        found.push({ type, field });
      }
    }
  }
  return found;
}

function findUnregisteredNotifierSecrets(
  schemas: Record<string, z.ZodTypeAny>,
  registered: ReadonlySet<string>,
): Array<{ type: string; field: string }> {
  return findSecretShapedNotifierFields(schemas).filter(({ field }) => !registered.has(field));
}
import { createIndexerSchema } from '../../shared/schemas/indexer.js';
import { createNotifierSchema } from '../../shared/schemas/notifier.js';
import { createDownloadClientSchema } from '../../shared/schemas/download-client.js';
import { createImportListSchema } from '../../shared/schemas/import-list.js';
import { createConnectorSchema, makeUpdateConnectorSchema, connectorSettingsSchemas, connectorTypeSchema } from '../../shared/schemas/connector.js';

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

  describe('#1357 opportunistic decrypt (rollback-proofing)', () => {
    // `futureSecret` is deliberately absent from SECRET_FIELDS for every entity.
    // Using a key the real registry doesn't know about proves the opportunistic
    // path against the production registry — no vi.mock of the private
    // SECRET_FIELDS is needed (and could not work: decryptFields resolves the
    // registry through the same-module getSecretFieldNames binding that vi.mock
    // cannot intercept — see CLAUDE.md "ESM same-module calls bypass vi.mock").

    it('decryptFields decrypts an $ENC$ value under a key NOT in SECRET_FIELDS', () => {
      const row = { futureSecret: encrypt('rolled-forward', TEST_KEY), ntfyServer: 'https://ntfy.sh' };
      const decrypted = decryptFields('notifier', row, TEST_KEY);
      expect(decrypted.futureSecret).toBe('rolled-forward');
      // Non-encrypted sibling untouched.
      expect(decrypted.ntfyServer).toBe('https://ntfy.sh');
    });

    it('encryptFields and maskFields leave an unregistered key untouched (encrypt/mask stay registry-scoped)', () => {
      const plaintext = 'a-real-future-secret';
      const encrypted = encryptFields('notifier', { futureSecret: plaintext }, TEST_KEY);
      expect(encrypted.futureSecret).toBe(plaintext); // not encrypted — outside the registry
      const masked = maskFields('notifier', { futureSecret: plaintext });
      expect(masked.futureSecret).toBe(plaintext); // not masked — outside the registry
    });

    it('passes a malformed non-base64 $ENC$ blob through unchanged without throwing', () => {
      const row = { futureSecret: '$ENC$not-valid-base64!!' };
      expect(() => decryptFields('notifier', row, TEST_KEY)).not.toThrow();
      expect(row.futureSecret).toBe('$ENC$not-valid-base64!!');
    });

    it('passes an undersized $ENC$ payload (shorter than IV+auth-tag) through unchanged', () => {
      const undersized = '$ENC$' + Buffer.from('shorttag').toString('base64'); // 8 bytes < 12+16
      const row = { futureSecret: undersized };
      expect(() => decryptFields('notifier', row, TEST_KEY)).not.toThrow();
      expect(row.futureSecret).toBe(undersized);
    });

    it('passes a corrupted-auth-tag $ENC$ value through unchanged (decipher.final failure)', () => {
      const valid = encrypt('secret', TEST_KEY);
      const payload = Buffer.from(valid.slice('$ENC$'.length), 'base64');
      payload[13] = payload[13]! ^ 0xff; // flip a byte inside the 16-byte auth tag (offset 12..27)
      const corrupted = '$ENC$' + payload.toString('base64');
      const row = { pushoverUser: corrupted }; // a registered field — still must passthrough on failure
      expect(() => decryptFields('notifier', row, TEST_KEY)).not.toThrow();
      expect(row.pushoverUser).toBe(corrupted);
    });

    it('leaves a plaintext (non-$ENC$) value untouched', () => {
      const row = { futureSecret: 'just-plaintext' };
      expect(decryptFields('notifier', row, TEST_KEY).futureSecret).toBe('just-plaintext');
    });

    it('mixed-row read: decrypts the $ENC$ field, returns the plaintext sibling verbatim', () => {
      const row = { encryptedField: encrypt('decrypted-value', TEST_KEY), plaintextSibling: 'x' };
      const decrypted = decryptFields('notifier', row, TEST_KEY);
      expect(decrypted.encryptedField).toBe('decrypted-value');
      expect(decrypted.plaintextSibling).toBe('x');
    });
  });

  describe('#1404 decrypt-failure diagnostic logging', () => {
    // A logger stub exposing just the `warn` spy decryptFields touches.
    function mockLogger(): { warn: ReturnType<typeof vi.fn>; logger: FastifyBaseLogger } {
      const warn = vi.fn();
      return { warn, logger: { warn } as unknown as FastifyBaseLogger };
    }

    // A registered secret field holding a $ENC$ blob that fails to decrypt
    // (corrupted auth tag under the right key — the lost/regenerated-key symptom).
    function corruptBlob(): string {
      const valid = encrypt('secret', TEST_KEY);
      const payload = Buffer.from(valid.slice('$ENC$'.length), 'base64');
      payload[13] = payload[13]! ^ 0xff; // flip a byte inside the 16-byte auth tag
      return '$ENC$' + payload.toString('base64');
    }

    it('emits exactly one warn naming the entity and failed field, passthrough preserved', () => {
      const { warn, logger } = mockLogger();
      const blob = corruptBlob();
      const row = { apiKey: blob, hostname: 'example.com' };
      const result = decryptFields('indexer', row, TEST_KEY, logger);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { entity: 'indexer', failedFields: ['apiKey'] },
        expect.stringContaining('secret.key'),
      );
      // #1357 passthrough unchanged — the corrupt blob is returned verbatim.
      expect(result.apiKey).toBe(blob);
      expect(result.hostname).toBe('example.com');
    });

    it('collects multiple failed fields into a single warn (not one per field)', () => {
      const { warn, logger } = mockLogger();
      decryptFields('downloadClient', { password: corruptBlob(), apiKey: corruptBlob() }, TEST_KEY, logger);

      expect(warn).toHaveBeenCalledTimes(1);
      const [arg] = warn.mock.calls[0]!;
      expect(arg).toEqual({ entity: 'downloadClient', failedFields: ['password', 'apiKey'] });
    });

    it('does not warn when all fields decrypt successfully', () => {
      const { warn, logger } = mockLogger();
      const encrypted = encryptFields('indexer', { apiKey: 'k', hostname: 'h' }, TEST_KEY);
      decryptFields('indexer', encrypted, TEST_KEY, logger);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn when there is nothing encrypted to fail', () => {
      const { warn, logger } = mockLogger();
      decryptFields('indexer', { hostname: 'example.com', apiKey: 'plaintext' }, TEST_KEY, logger);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is a no-op (no throw) when no logger is passed — passthrough still preserved', () => {
      const blob = corruptBlob();
      const row = { apiKey: blob };
      expect(() => decryptFields('indexer', row, TEST_KEY)).not.toThrow();
      expect(row.apiKey).toBe(blob);
    });

    it('never logs a decrypted value or the raw $ENC$ blob (negative-leak)', () => {
      const { warn, logger } = mockLogger();
      const blob = corruptBlob();
      // A sibling that DOES decrypt — its plaintext must not leak into the warn either.
      const decryptable = encrypt('super-secret-plaintext', TEST_KEY);
      decryptFields('indexer', { apiKey: blob, apiUrl: decryptable }, TEST_KEY, logger);

      const serialized = JSON.stringify(warn.mock.calls);
      expect(serialized).not.toContain('super-secret-plaintext');
      expect(serialized).not.toContain('$ENC$');
      expect(serialized).not.toContain(blob);
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

    it('maskFields preserves empty string across the secret entities', () => {
      expect(maskFields('network', { proxyUrl: '' }).proxyUrl).toBe('');
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
    it('getSecretFieldNames("notifier") returns the union of per-type secret fields', () => {
      const fields = getSecretFieldNames('notifier');
      const expected = ['url', 'webhookUrl', 'botToken', 'smtpPass', 'pushoverToken', 'pushoverUser', 'gotifyToken', 'ntfyTopic', 'ntfyAccessToken', 'headers'];
      expect([...fields].sort()).toEqual([...expected].sort());
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

    it('encryptFields skips the script notifier type (no secret fields)', () => {
      const script = encryptFields('notifier', { path: '/tmp/x.sh', timeout: 30 }, TEST_KEY);
      expect(script.path).toBe('/tmp/x.sh');
      expect(script.timeout).toBe(30);
    });

    it('#1307 encrypts pushoverUser and ntfyTopic, leaves non-secret siblings plaintext', () => {
      const pushover = encryptFields('notifier', { pushoverToken: 'tok', pushoverUser: 'u-abc' }, TEST_KEY);
      expect(isEncrypted(pushover.pushoverToken as string)).toBe(true);
      expect(isEncrypted(pushover.pushoverUser as string)).toBe(true);
      expect(decryptFields('notifier', { ...pushover }, TEST_KEY).pushoverUser).toBe('u-abc');

      const ntfy = encryptFields('notifier', { ntfyTopic: 't-xyz', ntfyServer: 'https://ntfy.sh' }, TEST_KEY);
      expect(isEncrypted(ntfy.ntfyTopic as string)).toBe(true);
      expect(ntfy.ntfyServer).toBe('https://ntfy.sh');
      expect(decryptFields('notifier', { ...ntfy }, TEST_KEY).ntfyTopic).toBe('t-xyz');

      const gotify = encryptFields('notifier', { gotifyToken: 'gt', gotifyUrl: 'https://gotify.test' }, TEST_KEY);
      expect(gotify.gotifyUrl).toBe('https://gotify.test');
    });

    it('#1307 maskFields masks pushoverUser and ntfyTopic; empty/null pass through', () => {
      const masked = maskFields('notifier', { pushoverUser: 'u-abc', ntfyTopic: 't-xyz', ntfyServer: 'https://ntfy.sh' });
      expect(masked.pushoverUser).toBe('********');
      expect(masked.ntfyTopic).toBe('********');
      expect(masked.ntfyServer).toBe('https://ntfy.sh');

      const empty = maskFields('notifier', { pushoverUser: '', ntfyTopic: null } as Record<string, unknown>);
      expect(empty.pushoverUser).toBe('');
      expect(empty.ntfyTopic).toBeNull();
    });

    it('#1307 sentinel-passthrough retains existing ciphertext for pushoverUser/ntfyTopic and re-encrypts new values', () => {
      const allow = getSecretFieldNames('notifier');
      const existing = {
        pushoverUser: encrypt('real-user', TEST_KEY),
        ntfyTopic: encrypt('real-topic', TEST_KEY),
      };
      // Sentinel resolves to the stored ciphertext byte-for-byte...
      const resolved = resolveSentinelFields(
        { pushoverUser: '********', ntfyTopic: '********' },
        existing,
        allow,
      );
      expect(resolved.pushoverUser).toBe(existing.pushoverUser);
      expect(resolved.ntfyTopic).toBe(existing.ntfyTopic);
      // ...and encryptFields does not re-encrypt an already-encrypted value (isEncrypted skip path).
      const reEncrypted = encryptFields('notifier', { ...resolved } as Record<string, unknown>, TEST_KEY);
      expect(reEncrypted.pushoverUser).toBe(existing.pushoverUser);
      expect(reEncrypted.ntfyTopic).toBe(existing.ntfyTopic);

      // A non-sentinel new value passes resolution untouched and IS encrypted on write.
      const newValue = resolveSentinelFields({ pushoverUser: 'brand-new-user' }, existing, allow);
      expect(newValue.pushoverUser).toBe('brand-new-user');
      const encrypted = encryptFields('notifier', { ...newValue } as Record<string, unknown>, TEST_KEY);
      expect(isEncrypted(encrypted.pushoverUser as string)).toBe(true);
      expect(decryptFields('notifier', { ...encrypted }, TEST_KEY).pushoverUser).toBe('brand-new-user');
    });

    it('#1607 encrypts and masks ntfyAccessToken, leaves ntfyPriority/ntfyServer plaintext', () => {
      const encrypted = encryptFields(
        'notifier',
        { ntfyTopic: 't', ntfyAccessToken: 'tk_secret', ntfyPriority: 'high', ntfyServer: 'https://ntfy.sh' },
        TEST_KEY,
      );
      expect(isEncrypted(encrypted.ntfyAccessToken as string)).toBe(true);
      expect(encrypted.ntfyPriority).toBe('high');
      expect(encrypted.ntfyServer).toBe('https://ntfy.sh');
      expect(decryptFields('notifier', { ...encrypted }, TEST_KEY).ntfyAccessToken).toBe('tk_secret');

      const masked = maskFields('notifier', { ntfyAccessToken: 'tk_secret', ntfyPriority: 'high', ntfyServer: 'https://ntfy.sh' });
      expect(masked.ntfyAccessToken).toBe('********');
      expect(masked.ntfyPriority).toBe('high');
      expect(masked.ntfyServer).toBe('https://ntfy.sh');
    });

    it('#1607 sentinel-passthrough retains existing ciphertext for ntfyAccessToken', () => {
      const allow = getSecretFieldNames('notifier');
      const existing = { ntfyAccessToken: encrypt('real-token', TEST_KEY) };
      const resolved = resolveSentinelFields({ ntfyAccessToken: '********' }, existing, allow);
      expect(resolved.ntfyAccessToken).toBe(existing.ntfyAccessToken);
      const reEncrypted = encryptFields('notifier', { ...resolved } as Record<string, unknown>, TEST_KEY);
      expect(reEncrypted.ntfyAccessToken).toBe(existing.ntfyAccessToken);
      expect(decryptFields('notifier', { ...reEncrypted }, TEST_KEY).ntfyAccessToken).toBe('real-token');
    });

    it('every per-type schema secret field is registered (drift guard)', () => {
      const registered = new Set(getSecretFieldNames('notifier'));
      const unregistered = findUnregisteredNotifierSecrets(notifierSettingsSchemas, registered);
      const detail = unregistered.map(({ type, field }) => `${type}.${field}`).join(', ');
      expect(
        unregistered,
        `Notifier subtypes contain secret-shaped fields not in SECRET_FIELDS["notifier"]: ${detail}`,
      ).toEqual([]);
    });

    it('heuristic against real notifier schemas flags exactly today\'s secret fields with subtype mappings', () => {
      // Locks in the heuristic's positive output — without this, removing one of
      // the exact-name regex alternatives (`url`, `webhookUrl`, `headers`) would
      // not surface in any other test on this file, because those fields are
      // already registered (drift guard would still return empty) and the
      // false-positive fixture only exercises non-matching names.
      const flagged = findSecretShapedNotifierFields(notifierSettingsSchemas);
      const sortKey = (a: { type: string; field: string }) => `${a.type}.${a.field}`;
      const sorted = [...flagged].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      expect(sorted).toEqual([
        { type: 'discord', field: 'webhookUrl' },
        { type: 'email', field: 'smtpPass' },
        { type: 'gotify', field: 'gotifyToken' },
        { type: 'ntfy', field: 'ntfyAccessToken' },
        { type: 'ntfy', field: 'ntfyTopic' },
        { type: 'pushover', field: 'pushoverToken' },
        { type: 'pushover', field: 'pushoverUser' },
        { type: 'slack', field: 'webhookUrl' },
        { type: 'telegram', field: 'botToken' },
        { type: 'webhook', field: 'headers' },
        { type: 'webhook', field: 'url' },
      ]);
      // And confirm the heuristic doesn't pull in any of the documented non-secret
      // fields. smtpUser matches the `*User` suffix but is an SMTP username, not a
      // credential — it is excluded via the explicit false-positive denylist.
      const flaggedFields = new Set(flagged.map(({ field }) => field));
      for (const nonSecret of ['gotifyUrl', 'ntfyServer', 'chatId', 'smtpHost', 'smtpUser', 'fromAddress', 'toAddress', 'path', 'method', 'bodyTemplate']) {
        expect(flaggedFields.has(nonSecret), `${nonSecret} should not be flagged as secret-shaped`).toBe(false);
      }
    });

    it('drift guard helper flags secret-shaped fields missing from the registered set', () => {
      const fakeSchemas = {
        fakeType: z.object({ secretToken: z.string() }).strict(),
      };
      const unregistered = findUnregisteredNotifierSecrets(fakeSchemas, new Set());
      expect(unregistered).toEqual([{ type: 'fakeType', field: 'secretToken' }]);
    });

    it('drift guard helper flags multiple secret-shaped fields and names each subtype', () => {
      const fakeSchemas = {
        typeA: z.object({ apiToken: z.string(), name: z.string() }).strict(),
        typeB: z.object({ apiPass: z.string() }).strict(),
      };
      const unregistered = findUnregisteredNotifierSecrets(fakeSchemas, new Set());
      expect(unregistered).toEqual(expect.arrayContaining([
        { type: 'typeA', field: 'apiToken' },
        { type: 'typeB', field: 'apiPass' },
      ]));
      expect(unregistered).toHaveLength(2);
    });

    it('drift guard helper does not flag non-secret-shaped fields like gotifyUrl/ntfyServer', () => {
      const fakeSchemas = {
        fakeType: z.object({ gotifyUrl: z.string(), ntfyServer: z.string() }).strict(),
      };
      const unregistered = findUnregisteredNotifierSecrets(fakeSchemas, new Set());
      expect(unregistered).toEqual([]);
    });

    it('#1307 drift guard flags an unregistered field ending in User or Topic', () => {
      const fakeSchemas = {
        typeA: z.object({ accountUser: z.string(), name: z.string() }).strict(),
        typeB: z.object({ channelTopic: z.string() }).strict(),
      };
      const unregistered = findUnregisteredNotifierSecrets(fakeSchemas, new Set());
      expect(unregistered).toEqual(expect.arrayContaining([
        { type: 'typeA', field: 'accountUser' },
        { type: 'typeB', field: 'channelTopic' },
      ]));
      expect(unregistered).toHaveLength(2);
    });

    it('#1307 heuristic does not regress smtpUser into a false positive', () => {
      const fakeSchemas = {
        email: z.object({ smtpUser: z.string(), smtpHost: z.string() }).strict(),
      };
      // email.smtpUser matches the `*User` suffix but is on the explicit
      // false-positive denylist, so it is neither flagged as secret-shaped nor
      // reported as a registry miss even when the registered set is empty.
      expect(findSecretShapedNotifierFields(fakeSchemas)).toEqual([]);
      expect(findUnregisteredNotifierSecrets(fakeSchemas, new Set())).toEqual([]);
    });

    it('#1357 heuristic matches the *Key, *Secret, *Password suffixes', () => {
      const fakeSchemas = {
        widget: z.object({ fooKey: z.string(), fooSecret: z.string(), fooPassword: z.string(), name: z.string() }).strict(),
      };
      const flagged = findSecretShapedNotifierFields(fakeSchemas);
      expect(flagged).toEqual(expect.arrayContaining([
        { type: 'widget', field: 'fooKey' },
        { type: 'widget', field: 'fooSecret' },
        { type: 'widget', field: 'fooPassword' },
      ]));
      // `name` is not secret-shaped and is not flagged.
      expect(flagged).toHaveLength(3);
    });

    it('#1357 denylist is keyed by (type, field): email.smtpUser exempt, webhook.smtpUser flagged', () => {
      const fakeSchemas = {
        email: z.object({ smtpUser: z.string() }).strict(),
        webhook: z.object({ smtpUser: z.string() }).strict(),
      };
      // The bare `smtpUser` name is not globally exempt — only `email.smtpUser`
      // is. A future non-email type reusing the same name for a real secret is
      // still flagged.
      const flagged = findSecretShapedNotifierFields(fakeSchemas);
      expect(flagged).toEqual([{ type: 'webhook', field: 'smtpUser' }]);
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
  const indexerAllow = getSecretFieldNames('indexer');

  it('replaces sentinel values with existing encrypted values', () => {
    const incoming = { apiKey: '********', hostname: 'example.com' };
    const existing = { apiKey: '$ENC$encrypted-key', hostname: 'old.com' };
    const result = resolveSentinelFields(incoming, existing, indexerAllow);
    expect(result.apiKey).toBe('$ENC$encrypted-key');
    expect(result.hostname).toBe('example.com');
  });

  it('passes through non-sentinel values unchanged', () => {
    const incoming = { apiKey: 'new-real-key', hostname: 'new.com' };
    const existing = { apiKey: '$ENC$old-key', hostname: 'old.com' };
    const result = resolveSentinelFields(incoming, existing, indexerAllow);
    expect(result.apiKey).toBe('new-real-key');
    expect(result.hostname).toBe('new.com');
  });

  it('handles empty incoming settings object', () => {
    const incoming = {};
    const existing = { apiKey: '$ENC$old-key' };
    const result = resolveSentinelFields(incoming, existing, indexerAllow);
    expect(result).toEqual({});
  });

  it('handles fields present in incoming but missing in existing', () => {
    const incoming = { apiKey: '********', newField: 'value' };
    const existing = { hostname: 'old.com' };
    const result = resolveSentinelFields(incoming, existing, indexerAllow);
    // apiKey sentinel has no match in existing — keeps undefined (existing value)
    expect(result.apiKey).toBeUndefined();
    expect(result.newField).toBe('value');
  });

  it('handles null/undefined existing record', () => {
    const incoming = { apiKey: '********', hostname: 'new.com' };
    const result = resolveSentinelFields(incoming, null, indexerAllow);
    // No existing record to look up — sentinel stays as undefined
    expect(result.apiKey).toBeUndefined();
    expect(result.hostname).toBe('new.com');
  });

  it('throws SentinelOnNonSecretFieldError when sentinel lands on non-allowlisted key', () => {
    const incoming = { hostname: '********', apiKey: 'real' };
    const existing = { hostname: 'old.com', apiKey: 'old-key' };
    expect(() => resolveSentinelFields(incoming, existing, indexerAllow))
      .toThrow(SentinelOnNonSecretFieldError);
  });

  it('typed error carries the offending field name', () => {
    const incoming = { hostname: '********' };
    try {
      resolveSentinelFields(incoming, {}, indexerAllow);
      throw new Error('expected throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SentinelOnNonSecretFieldError);
      if (error instanceof SentinelOnNonSecretFieldError) {
        expect(error.field).toBe('hostname');
        expect(error.message).toContain('hostname');
      }
    }
  });

  it('replaces multiple allowlisted sentinels in a single pass', () => {
    const dlAllow = getSecretFieldNames('downloadClient');
    const incoming = { apiKey: '********', password: '********', host: 'h' };
    const existing = { apiKey: 'real-key', password: 'real-pw', host: 'old' };
    const result = resolveSentinelFields(incoming, existing, dlAllow);
    expect(result.apiKey).toBe('real-key');
    expect(result.password).toBe('real-pw');
    expect(result.host).toBe('h');
  });

  it('treats different allowlists for different entities (downloadClient host is non-secret)', () => {
    const dlAllow = getSecretFieldNames('downloadClient');
    const incoming = { host: '********' };
    expect(() => resolveSentinelFields(incoming, { host: 'old' }, dlAllow))
      .toThrow(SentinelOnNonSecretFieldError);
  });

  it('treats different allowlists for different entities (network proxyUrl is the only secret)', () => {
    const networkAllow = getSecretFieldNames('network');
    expect(networkAllow).toEqual(['proxyUrl']);
    const incoming = { proxyUrl: '********', someOther: 'plaintext' };
    const result = resolveSentinelFields(incoming, { proxyUrl: 'http://proxy', someOther: 'old' }, networkAllow);
    expect(result.proxyUrl).toBe('http://proxy');
    expect(result.someOther).toBe('plaintext');

    expect(() => resolveSentinelFields({ someOther: '********' }, { someOther: 'old' }, networkAllow))
      .toThrow(SentinelOnNonSecretFieldError);
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

    it('accepts sentinel for apiKey on nyt', () => {
      const r = schema.safeParse({
        name: 'nyt', type: 'nyt', enabled: true, syncIntervalMinutes: 1440,
        settings: { apiKey: '********', list: 'audio-fiction' },
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

  // #1499 — baseUrl gained a strict http(s) URL refinement, which rejects the
  // masked sentinel. The /test and /targets paths must still admit it via the
  // sentinel union (and the strict create superRefine must NOT re-run here).
  describe('connector — sentinel-aware baseUrl', () => {
    const testSchema = makeTestSchema(createConnectorSchema, 'connector');
    // Mirrors the /targets schema built in connectors.ts (no name required).
    const targetsSchema = makeTestSchema(
      z.object({ type: connectorTypeSchema, settings: z.record(z.string(), z.unknown()) }),
      'connector',
    );

    it('/test accepts sentinel baseUrl/apiKey for audiobookshelf', () => {
      const r = testSchema.safeParse({
        name: 'abs', type: 'audiobookshelf', enabled: true,
        settings: { baseUrl: '********', apiKey: '********', libraryId: 'lib-1' },
      });
      expect(r.success).toBe(true);
    });

    it('/test accepts sentinel baseUrl/token for plex', () => {
      const r = testSchema.safeParse({
        name: 'plex', type: 'plex', enabled: true,
        settings: { baseUrl: '********', token: '********', sectionId: '1' },
      });
      expect(r.success).toBe(true);
    });

    it('/test still rejects a real malformed baseUrl (loosening keeps the refinement)', () => {
      const r = testSchema.safeParse({
        name: 'abs', type: 'audiobookshelf', enabled: true,
        settings: { baseUrl: 'not a url', apiKey: '********', libraryId: 'lib-1' },
      });
      expect(r.success).toBe(false);
    });

    it('/targets accepts sentinel baseUrl', () => {
      const r = targetsSchema.safeParse({
        type: 'audiobookshelf',
        settings: { baseUrl: '********', apiKey: '********', libraryId: 'lib-1' },
      });
      expect(r.success).toBe(true);
    });

    it('/targets still rejects a real schemeless baseUrl', () => {
      const r = targetsSchema.safeParse({
        type: 'audiobookshelf',
        settings: { baseUrl: 'localhost:13378', apiKey: '********', libraryId: 'lib-1' },
      });
      expect(r.success).toBe(false);
    });
  });
});

// #1499 — the connector PUT route wires this exact schema (see connectors.ts).
// Build it the same way to assert the wired update path, not just the service.
describe('connector update schema (sentinel-aware PUT path)', () => {
  const updateSchema = makeUpdateConnectorSchema(
    loosenSettingsSchemas(connectorSettingsSchemas, 'connector'),
  );

  it('accepts masked baseUrl + apiKey edits for audiobookshelf', () => {
    const r = updateSchema.safeParse({
      type: 'audiobookshelf',
      settings: { baseUrl: '********', apiKey: '********', libraryId: 'lib-1' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts masked baseUrl + token edits for plex', () => {
    const r = updateSchema.safeParse({
      type: 'plex',
      settings: { baseUrl: '********', token: '********', sectionId: '1' },
    });
    expect(r.success).toBe(true);
  });

  it('still rejects a real malformed baseUrl on update', () => {
    const r = updateSchema.safeParse({
      type: 'audiobookshelf',
      settings: { baseUrl: 'not a url', apiKey: '********', libraryId: 'lib-1' },
    });
    expect(r.success).toBe(false);
  });

  it('normalizes a real baseUrl on update (trailing slash stripped)', () => {
    const r = updateSchema.safeParse({
      type: 'audiobookshelf',
      settings: { baseUrl: 'http://example.com/', apiKey: '********', libraryId: 'lib-1' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data.settings as { baseUrl: string }).baseUrl).toBe('http://example.com');
    }
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
