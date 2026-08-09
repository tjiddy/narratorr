import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, createHmac, timingSafeEqual, scrypt } from 'node:crypto';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal();
  const mod = actual as Record<string, unknown> & {
    timingSafeEqual: typeof timingSafeEqual;
    scrypt: typeof scrypt;
  };
  return { ...mod, timingSafeEqual: vi.fn(mod.timingSafeEqual), scrypt: vi.fn(mod.scrypt) };
});
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService, NoCredentialsError } from './auth.service.js';
import { createMockDb, createMockLogger, mockDbChain, inject } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, isEncrypted, decryptFields } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

describe('AuthService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: AuthService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new AuthService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  describe('initialize', () => {
    it('creates default auth settings (mode=none, apiKey, sessionSecret) on first run', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      await service.initialize();

      expect(db.insert).toHaveBeenCalled();
      const insertChain = db.insert.mock.results[0]!.value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.key).toBe('auth');
      const config = valuesCall.value;
      expect(config.mode).toBe('none');
      expect(isEncrypted(config.apiKey)).toBe(true);
      expect(isEncrypted(config.sessionSecret)).toBe(true);
      expect(config.localBypass).toBe(false);
    });

    it('is idempotent (does not overwrite existing settings)', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: { mode: 'none', apiKey: 'existing' } }]));

      await service.initialize();

      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('createUser', () => {
    it('hashes password with scrypt, stores in users table', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      await service.createUser('admin', 'password123');

      expect(db.insert).toHaveBeenCalled();
      const insertChain = db.insert.mock.results[0]!.value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.username).toBe('admin');
      expect(valuesCall.passwordHash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    });

    it('rejects when user already exists', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: 'x:y' }]));

      await expect(service.createUser('admin', 'password123')).rejects.toThrow('User already exists');
    });
  });

  describe('verifyCredentials', () => {
    it('returns user on valid credentials', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // createUser check
      await service.createUser('admin', 'password123');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));
      const result = await service.verifyCredentials('admin', 'password123');
      expect(result).toEqual({ username: 'admin' });
    });

    it('returns null on invalid password', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'password123');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));
      const result = await service.verifyCredentials('admin', 'wrongpassword');
      expect(result).toBeNull();
    });

    it('returns null on nonexistent username', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.verifyCredentials('nobody', 'password123');
      expect(result).toBeNull();
    });

    // Every null path still pays one dummy scrypt so username existence is not timing-visible.
    it('runs scrypt on the user-not-found branch (timing-oracle mitigation)', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      vi.mocked(scrypt).mockClear();

      const result = await service.verifyCredentials('nobody', 'password123');

      expect(result).toBeNull();
      expect(scrypt).toHaveBeenCalledTimes(1);
    });

    it('runs scrypt on the valid-user branch (parity with user-not-found)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // createUser check
      await service.createUser('admin', 'password123');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));
      // Clear the createUser setup scrypt call so we only count verifyCredentials.
      vi.mocked(scrypt).mockClear();

      const result = await service.verifyCredentials('admin', 'password123');

      expect(result).toEqual({ username: 'admin' });
      expect(scrypt).toHaveBeenCalledTimes(1);
    });

    it('runs scrypt on the malformed-passwordHash branch', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: 'notavalidhash' }]));
      vi.mocked(scrypt).mockClear();

      const result = await service.verifyCredentials('admin', 'password123');

      expect(result).toBeNull();
      expect(scrypt).toHaveBeenCalledTimes(1);
    });

    it('reuses a process-scoped DUMMY_SALT across user-not-found calls', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      vi.mocked(scrypt).mockClear();

      await service.verifyCredentials('nobody', 'password123');
      await service.verifyCredentials('alsonobody', 'differentpw');

      expect(scrypt).toHaveBeenCalledTimes(2);
      // The salt is the second positional arg: scrypt(password, salt, keylen, cb).
      const firstSalt = vi.mocked(scrypt).mock.calls[0]![1] as Buffer;
      const secondSalt = vi.mocked(scrypt).mock.calls[1]![1] as Buffer;
      expect(Buffer.isBuffer(firstSalt)).toBe(true);
      // The dummy salt must match createUser's 16-byte salt size.
      expect(firstSalt.length).toBe(16);
      expect((firstSalt as Buffer).equals(secondSalt)).toBe(true);
    });
  });

  describe('updateLocalBypass', () => {
    it('updateLocalBypass(true) sets config.localBypass=true and preserves apiKey and sessionSecret', async () => {
      const authConfig = { mode: 'none' as const, apiKey: 'original-key', sessionSecret: 'original-secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await service.updateLocalBypass(true);

      const insertChain = db.insert.mock.results[0]!.value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.key).toBe('auth');
      const stored = valuesCall.value as { mode: string; apiKey: string; sessionSecret: string; localBypass: boolean };
      expect(stored.localBypass).toBe(true);
      const decrypted = decryptFields('auth', { ...stored }, TEST_KEY) as typeof authConfig;
      expect(decrypted.apiKey).toBe('original-key');
      expect(decrypted.sessionSecret).toBe('original-secret');
    });

    it('updateLocalBypass(false) sets config.localBypass=false and preserves apiKey and sessionSecret', async () => {
      const authConfig = { mode: 'none' as const, apiKey: 'original-key', sessionSecret: 'original-secret', localBypass: true };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await service.updateLocalBypass(false);

      const insertChain = db.insert.mock.results[0]!.value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      const stored = valuesCall.value as { mode: string; apiKey: string; sessionSecret: string; localBypass: boolean };
      expect(stored.localBypass).toBe(false);
      const decrypted = decryptFields('auth', { ...stored }, TEST_KEY) as typeof authConfig;
      expect(decrypted.apiKey).toBe('original-key');
      expect(decrypted.sessionSecret).toBe('original-secret');
    });
  });

  describe('changePassword', () => {
    const rotationConfig = (sessionSecret = 'old-session-secret') => ({
      key: 'auth',
      value: { mode: 'forms' as const, apiKey: 'api-key-123', sessionSecret, localBypass: false },
    });

    it('succeeds with correct current password and returns the effective username', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      // verifyCredentials select, then the rotation-config select.
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]))
        .mockReturnValueOnce(mockDbChain([rotationConfig()]));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await expect(service.changePassword('admin', 'oldpassword', 'newpassword')).resolves.toBe('admin');
      expect(db.update).toHaveBeenCalled();
    });

    it('returns the new username as the effective username when renamed', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const storedHash = db.insert.mock.results[0]!.value.values.mock.calls[0][0].passwordHash;

      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]))
        .mockReturnValueOnce(mockDbChain([rotationConfig()]));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await expect(service.changePassword('admin', 'oldpassword', 'newpassword', 'newadmin')).resolves.toBe('newadmin');
    });

    it('rotates sessionSecret so a cookie signed with the old secret no longer verifies (AC#1, AC#2)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const storedHash = db.insert.mock.results[0]!.value.values.mock.calls[0][0].passwordHash;

      const oldSecret = 'old-session-secret';
      const oldCookie = service.createSessionCookie('admin', oldSecret);
      expect(service.verifySessionCookie(oldCookie, oldSecret)).not.toBeNull();

      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]))
        .mockReturnValueOnce(mockDbChain([rotationConfig(oldSecret)]));
      db.insert.mockClear();
      db.insert.mockReturnValue(mockDbChain(undefined));

      await service.changePassword('admin', 'oldpassword', 'newpassword');

      const storedConfig = db.insert.mock.results[0]!.value.values.mock.calls[0][0].value as { sessionSecret: string; apiKey: string };
      expect(isEncrypted(storedConfig.sessionSecret)).toBe(true);
      const decrypted = decryptFields('auth', { ...storedConfig }, TEST_KEY) as { sessionSecret: string; apiKey: string };
      const newSecret = decrypted.sessionSecret;
      expect(newSecret).not.toBe(oldSecret);
      expect(decrypted.apiKey).toBe('api-key-123');

      expect(service.verifySessionCookie(oldCookie, newSecret)).toBeNull();
      const newCookie = service.createSessionCookie('admin', newSecret);
      expect(service.verifySessionCookie(newCookie, newSecret)).not.toBeNull();
    });

    it('does NOT rotate the secret when the current password is wrong (AC#5)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const storedHash = db.insert.mock.results[0]!.value.values.mock.calls[0][0].passwordHash;

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));
      db.update.mockClear();
      db.insert.mockClear();

      await expect(service.changePassword('admin', 'wrongpassword', 'newpassword'))
        .rejects.toThrow('Current password is incorrect');

      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('propagates a rotation-write failure after the credential update (AC#7)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const storedHash = db.insert.mock.results[0]!.value.values.mock.calls[0][0].passwordHash;

      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]))
        .mockReturnValueOnce(mockDbChain([rotationConfig()]));
      db.update.mockClear();
      db.update.mockReturnValue(mockDbChain(undefined)); // credential update succeeds
      db.insert.mockReturnValue(mockDbChain(undefined, { error: new Error('rotation write failed') })); // setAuthConfig rejects

      await expect(service.changePassword('admin', 'oldpassword', 'newpassword'))
        .rejects.toThrow('rotation write failed');
      expect(db.update).toHaveBeenCalled();
    });

    it('timingSafeEqual is called with stored and derived hash buffers on correct password', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'correctpass');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedPasswordHash = insertChain.values.mock.calls[0][0].passwordHash as string;
      const [, hashHex] = storedPasswordHash.split(':');
      const expectedStoredBuf = Buffer.from(hashHex!, 'hex');

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedPasswordHash }]));
      vi.clearAllMocks();
      const result = await service.verifyCredentials('admin', 'correctpass');

      expect(result).toEqual({ username: 'admin' });
      expect(timingSafeEqual).toHaveBeenCalledWith(expectedStoredBuf, expect.any(Buffer));
    });

    it('timingSafeEqual is called during verifyCredentials (not short-circuited on wrong password)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'correctpass');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedPasswordHash = insertChain.values.mock.calls[0][0].passwordHash as string;
      const [, hashHex] = storedPasswordHash.split(':');
      const expectedStoredBuf = Buffer.from(hashHex!, 'hex');

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedPasswordHash }]));
      vi.clearAllMocks();
      const result = await service.verifyCredentials('admin', 'wrongpass');

      expect(result).toBeNull();
      expect(timingSafeEqual).toHaveBeenCalledWith(expectedStoredBuf, expect.any(Buffer));
    });
    it('rejects with incorrect current password', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const insertChain = db.insert.mock.results[0]!.value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));

      await expect(service.changePassword('admin', 'wrongpassword', 'newpassword'))
        .rejects.toThrow('Current password is incorrect');
    });
  });

  describe('updateMode', () => {
    it('rejects forms/basic when no user exists', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([])) // user count check
        ;

      await expect(service.updateMode('forms')).rejects.toThrow('Cannot enable auth mode without credentials configured');
      await expect(service.updateMode('basic')).rejects.toThrow('Cannot enable auth mode without credentials configured');
    });

    it('allows switching to "none" without user', async () => {
      const authConfig = { mode: 'forms', apiKey: 'test-key', sessionSecret: 'test-secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));

      const result = await service.updateMode('none');
      expect(result.mode).toBe('none');
    });
  });

  describe('decrypted blob validation', () => {
    it('throws when the decrypted blob is missing required fields', async () => {
      const malformed = { mode: 'none' };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: malformed }]));

      await expect(service.getStatus()).rejects.toThrow();
    });

    it('throws when the decrypted blob has wrong field types', async () => {
      const wrongTypes = { mode: 'none', apiKey: 123, sessionSecret: 'secret', localBypass: 'no' };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: wrongTypes }]));

      await expect(service.getStatus()).rejects.toThrow();
    });
  });

  describe('API key', () => {
    it('regenerateApiKey returns a new key, persists it', async () => {
      const authConfig = { mode: 'none', apiKey: 'old-key', sessionSecret: 'secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));

      const newKey = await service.regenerateApiKey();
      expect(newKey).toBeDefined();
      expect(newKey).not.toBe('old-key');
      expect(db.insert).toHaveBeenCalled(); // setAuthConfig uses insert...onConflict
    });

    it('validateApiKey returns true for valid key, false for invalid', async () => {
      const authConfig = { mode: 'none', apiKey: 'test-key-123', sessionSecret: 'secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));

      expect(await service.validateApiKey('test-key-123')).toBe(true);
      expect(await service.validateApiKey('wrong-key')).toBe(false);
    });

    it('calls timingSafeEqual with SHA-256 hash buffers for correct key', async () => {
      const authConfig = { mode: 'none', apiKey: 'test-key-123', sessionSecret: 'secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      vi.mocked(timingSafeEqual).mockClear();

      const result = await service.validateApiKey('test-key-123');

      expect(result).toBe(true);
      const expectedHash = createHash('sha256').update('test-key-123').digest();
      expect(timingSafeEqual).toHaveBeenCalledWith(expectedHash, expectedHash);
    });

    it('calls timingSafeEqual for wrong key of same length (not short-circuited)', async () => {
      const authConfig = { mode: 'none', apiKey: 'test-key-123', sessionSecret: 'secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      vi.mocked(timingSafeEqual).mockClear();

      const result = await service.validateApiKey('wrong-key-00');

      expect(result).toBe(false);
      const expectedHash = createHash('sha256').update('test-key-123').digest();
      const providedHash = createHash('sha256').update('wrong-key-00').digest();
      expect(timingSafeEqual).toHaveBeenCalledWith(expectedHash, providedHash);
    });

    it('still calls timingSafeEqual for wrong key of different length (no length leak)', async () => {
      const authConfig = { mode: 'none', apiKey: 'test-key-123', sessionSecret: 'secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      vi.mocked(timingSafeEqual).mockClear();

      const result = await service.validateApiKey('short');

      expect(result).toBe(false);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      const expectedHash = createHash('sha256').update('test-key-123').digest();
      const providedHash = createHash('sha256').update('short').digest();
      expect(timingSafeEqual).toHaveBeenCalledWith(expectedHash, providedHash);
    });

    it('returns false but still calls timingSafeEqual for empty string key', async () => {
      const authConfig = { mode: 'none', apiKey: 'test-key-123', sessionSecret: 'secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      vi.mocked(timingSafeEqual).mockClear();

      const result = await service.validateApiKey('');

      expect(result).toBe(false);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteCredentials', () => {
    it('deletes all users and resets auth mode to none', async () => {
      const authConfig = { mode: 'forms' as const, apiKey: 'key', sessionSecret: 'sec', localBypass: false };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, username: 'admin', passwordHash: 'h:s' }])) // users check
        .mockReturnValueOnce(mockDbChain([{ key: 'auth', value: authConfig }])); // getAuthConfig inside setAuthConfig
      db.delete.mockReturnValue(mockDbChain(undefined));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await service.deleteCredentials();

      expect(db.delete).toHaveBeenCalled();

      const insertChain = db.insert.mock.results[0]!.value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.key).toBe('auth');
      const storedConfig = valuesCall.value as { mode: string; apiKey: string; sessionSecret: string; localBypass: boolean };
      expect(storedConfig.mode).toBe('none');
      expect(isEncrypted(storedConfig.apiKey)).toBe(true);
      expect(isEncrypted(storedConfig.sessionSecret)).toBe(true);
      expect(storedConfig.localBypass).toBe(false);
    });

    it('throws NoCredentialsError when no user exists', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      await expect(service.deleteCredentials()).rejects.toThrow(NoCredentialsError);
    });
  });

  describe('session cookie', () => {
    const secret = 'test-secret-key-for-hmac';

    it('createSessionCookie produces base64.signature format with correct expiry', () => {
      const cookie = service.createSessionCookie('admin', secret);
      const parts = cookie.split('.');
      expect(parts).toHaveLength(2);

      const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      expect(payload.username).toBe('admin');
      expect(payload.issuedAt).toBeTypeOf('number');
      expect(payload.expiresAt).toBeTypeOf('number');
      expect(payload.expiresAt - payload.issuedAt).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('verifySessionCookie returns payload for valid cookie', () => {
      const cookie = service.createSessionCookie('admin', secret);
      const result = service.verifySessionCookie(cookie, secret);

      expect(result).not.toBeNull();
      expect(result!.payload.username).toBe('admin');
      expect(result!.shouldRenew).toBe(false);
    });

    it('verifySessionCookie returns null for tampered signature', () => {
      const cookie = service.createSessionCookie('admin', secret);
      const tampered = cookie.slice(0, -5) + 'XXXXX';

      const result = service.verifySessionCookie(tampered, secret);
      expect(result).toBeNull();
    });

    it('verifySessionCookie returns null for expired cookie', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(now - 8 * 24 * 60 * 60 * 1000) // issuedAt: 8 days ago
        ;
      const cookie = service.createSessionCookie('admin', secret);
      vi.restoreAllMocks();

      const result = service.verifySessionCookie(cookie, secret);
      expect(result).toBeNull();
    });

    it('verifySessionCookie returns null for malformed cookie (wrong segment count)', () => {
      expect(service.verifySessionCookie('no-dots-here', secret)).toBeNull();
      expect(service.verifySessionCookie('one.two.three', secret)).toBeNull();
      expect(service.verifySessionCookie('', secret)).toBeNull();
    });

    it('verifySessionCookie returns null for corrupted base64 payload (valid sig, bad JSON)', () => {
      const corruptedB64 = Buffer.from('not-valid-json!!!').toString('base64url');
      const sig = createHmac('sha256', secret).update(corruptedB64).digest('base64url');
      const cookie = `${corruptedB64}.${sig}`;

      expect(service.verifySessionCookie(cookie, secret)).toBeNull();
    });

    it('getSessionSecret returns sessionSecret from auth config', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ key: 'auth', value: { mode: 'none', apiKey: 'key', sessionSecret: 'my-secret', localBypass: false } }]),
      );

      const result = await service.getSessionSecret();
      expect(result).toBe('my-secret');
    });

    it('getSessionSecret throws when auth config is missing (not initialized)', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      await expect(service.getSessionSecret()).rejects.toThrow('Auth settings not initialized');
    });

    it('verifySessionCookie returns null, invokes timingSafeEqual, and logs generic mismatch for wrong-length signature', () => {
      const payloadB64 = Buffer.from(JSON.stringify({
        username: 'admin',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })).toString('base64url');
      const shortSig = 'short';
      const cookie = `${payloadB64}.${shortSig}`;

      const log = inject<{ debug: ReturnType<typeof vi.fn> }>(createMockLogger());
      const logService = new AuthService(inject<Db>(db), log as never);

      vi.mocked(timingSafeEqual).mockClear();

      const result = logService.verifySessionCookie(cookie, secret);

      expect(result).toBeNull();
      expect(log.debug).toHaveBeenCalledWith('Auth: cookie signature mismatch');
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      // Both arguments are fixed-length SHA-256 digests.
      const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
      const expectedHash = createHash('sha256').update(expectedSig).digest();
      const providedHash = createHash('sha256').update(shortSig).digest();
      expect(timingSafeEqual).toHaveBeenCalledWith(providedHash, expectedHash);
    });

    it('verifySessionCookie still calls timingSafeEqual for both short and long bogus signatures (no length leak)', () => {
      const payloadB64 = Buffer.from(JSON.stringify({
        username: 'admin',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })).toString('base64url');

      vi.mocked(timingSafeEqual).mockClear();
      expect(service.verifySessionCookie(`${payloadB64}.x`, secret)).toBeNull();
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);

      vi.mocked(timingSafeEqual).mockClear();
      const longSig = 'a'.repeat(200);
      expect(service.verifySessionCookie(`${payloadB64}.${longSig}`, secret)).toBeNull();
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    });

    it('sliding expiry: cookie >50% through TTL flagged for renewal', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(now - 4 * 24 * 60 * 60 * 1000) // creation time
        ;
      const cookie = service.createSessionCookie('admin', secret);
      vi.restoreAllMocks();

      const result = service.verifySessionCookie(cookie, secret);
      expect(result).not.toBeNull();
      expect(result!.shouldRenew).toBe(true);
    });
  });

  // Domain-separated signing prevents stream tokens and session cookies from interchanging.
  describe('stream token (#1453)', () => {
    const secret = 'test-secret-key-for-hmac';

    it('mintStreamToken produces a base64.signature token that verifyStreamToken round-trips', () => {
      const token = service.mintStreamToken(secret);
      expect(token.split('.')).toHaveLength(2);

      const payload = service.verifyStreamToken(token, secret);
      expect(payload).not.toBeNull();
      expect(payload!.kind).toBe('stream');
      expect((payload as unknown as Record<string, unknown>).username).toBeUndefined();
    });

    it('verifyStreamToken returns null for a tampered signature', () => {
      const token = service.mintStreamToken(secret);
      const tampered = token.slice(0, -5) + 'XXXXX';
      expect(service.verifyStreamToken(tampered, secret)).toBeNull();
    });

    it('verifyStreamToken returns null for a tampered payload', () => {
      const token = service.mintStreamToken(secret);
      const [, sig] = token.split('.');
      const forgedPayload = Buffer.from(JSON.stringify({ kind: 'stream', issuedAt: 0, expiresAt: Date.now() + 10_000 })).toString('base64url');
      expect(service.verifyStreamToken(`${forgedPayload}.${sig}`, secret)).toBeNull();
    });

    it('verifyStreamToken returns null for an expired token', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValueOnce(now - 10 * 60 * 1000);
      const token = service.mintStreamToken(secret);
      vi.restoreAllMocks();

      expect(service.verifyStreamToken(token, secret)).toBeNull();
    });

    it('verifyStreamToken returns null for malformed input (wrong segment count)', () => {
      expect(service.verifyStreamToken('no-dots-here', secret)).toBeNull();
      expect(service.verifyStreamToken('one.two.three', secret)).toBeNull();
      expect(service.verifyStreamToken('', secret)).toBeNull();
    });

    it('stream-token TTL is short (5 minutes), independent of the 7-day session TTL', () => {
      const token = service.mintStreamToken(secret);
      const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
      expect(payload.expiresAt - payload.issuedAt).toBe(5 * 60 * 1000);
    });

    it('a session renewal between mint and verify does NOT invalidate a still-live stream token', () => {
      const token = service.mintStreamToken(secret);
      service.createSessionCookie('admin', secret);
      const payload = service.verifyStreamToken(token, secret);
      expect(payload).not.toBeNull();
      expect((payload as unknown as Record<string, unknown>).shouldRenew).toBeUndefined();
    });

    describe('cross-domain rejection', () => {
      it('a stream token does NOT verify via verifySessionCookie (no username / wrong secret)', () => {
        const token = service.mintStreamToken(secret);
        expect(service.verifySessionCookie(token, secret)).toBeNull();
      });

      it('a session cookie does NOT verify via verifyStreamToken (wrong kind / wrong secret)', () => {
        const cookie = service.createSessionCookie('admin', secret);
        expect(service.verifyStreamToken(cookie, secret)).toBeNull();
      });

      it('a hand-crafted {issuedAt,expiresAt} payload signed with the RAW session secret is rejected by verifyStreamToken', () => {
        // Reproduce the pre-domain-separation payload and raw-secret signature.
        const payloadB64 = Buffer.from(JSON.stringify({ issuedAt: Date.now(), expiresAt: Date.now() + 10_000 })).toString('base64url');
        const rawSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
        expect(service.verifyStreamToken(`${payloadB64}.${rawSig}`, secret)).toBeNull();
      });

      it('a kind:"stream" payload signed with the RAW session secret is rejected by verifySessionCookie (no username)', () => {
        const payloadB64 = Buffer.from(JSON.stringify({ kind: 'stream', issuedAt: Date.now(), expiresAt: Date.now() + 10_000 })).toString('base64url');
        const rawSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
        expect(service.verifySessionCookie(`${payloadB64}.${rawSig}`, secret)).toBeNull();
      });
    });

    describe('verifySessionCookie hardening (#1453)', () => {
      it('rejects an otherwise-valid HMAC payload that is missing username', () => {
        const payloadB64 = Buffer.from(JSON.stringify({ kind: 'session', issuedAt: Date.now(), expiresAt: Date.now() + 10_000 })).toString('base64url');
        const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
        expect(service.verifySessionCookie(`${payloadB64}.${sig}`, secret)).toBeNull();
      });

      it('rejects an otherwise-valid HMAC payload bearing kind:"stream"', () => {
        const payloadB64 = Buffer.from(JSON.stringify({ username: 'admin', kind: 'stream', issuedAt: Date.now(), expiresAt: Date.now() + 10_000 })).toString('base64url');
        const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
        expect(service.verifySessionCookie(`${payloadB64}.${sig}`, secret)).toBeNull();
      });

      it('accepts a legacy cookie (username present, kind absent) for backward compatibility', () => {
        const payloadB64 = Buffer.from(JSON.stringify({ username: 'admin', issuedAt: Date.now(), expiresAt: Date.now() + 10_000 })).toString('base64url');
        const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
        const result = service.verifySessionCookie(`${payloadB64}.${sig}`, secret);
        expect(result).not.toBeNull();
        expect(result!.payload.username).toBe('admin');
      });
    });
  });
});

describe('AuthService decrypt-failure diagnostic (#1404)', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: AuthService;

  async function corruptBlob(plaintext: string): Promise<string> {
    const { encrypt } = await import('../utils/secret-codec.js');
    const valid = encrypt(plaintext, TEST_KEY);
    const payload = Buffer.from(valid.slice('$ENC$'.length), 'base64');
    payload[13] = payload[13]! ^ 0xff;
    return '$ENC$' + payload.toString('base64');
  }

  function decryptWarn(): Array<[unknown, unknown]> {
    return (log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('secret.key'),
    ) as Array<[unknown, unknown]>;
  }

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
    service = new AuthService(inject<Db>(db), inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    _resetKey();
  });

  it('warns naming the auth entity and the field(s) that fail to decrypt on read', async () => {
    const apiKey = await corruptBlob('plaintext-api-key');
    const sessionSecret = await corruptBlob('plaintext-session-secret');
    db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: { mode: 'none', apiKey, sessionSecret, localBypass: false } }]));

    await service.validateApiKey('anything');

    const warns = decryptWarn();
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toEqual({ entity: 'auth', failedFields: ['apiKey', 'sessionSecret'] });
    const serialized = JSON.stringify(warns);
    expect(serialized).not.toContain('plaintext-api-key');
    expect(serialized).not.toContain('plaintext-session-secret');
    expect(serialized).not.toContain('$ENC$');
  });

  it('does not emit the decrypt warn when auth secrets decrypt cleanly', async () => {
    const { encrypt } = await import('../utils/secret-codec.js');
    const authConfig = {
      mode: 'none',
      apiKey: encrypt('clean-key', TEST_KEY),
      sessionSecret: encrypt('clean-secret', TEST_KEY),
      localBypass: false,
    };
    db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));

    expect(await service.validateApiKey('clean-key')).toBe(true);
    expect(decryptWarn()).toHaveLength(0);
  });
});
