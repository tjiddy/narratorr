import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal();
  const mod = actual as Record<string, unknown> & { timingSafeEqual: typeof timingSafeEqual };
  return { ...mod, timingSafeEqual: vi.fn(mod.timingSafeEqual) };
});
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { AuthService, NoCredentialsError } from './auth.service.js';
import { createMockDb, createMockLogger, mockDbChain, inject } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, isEncrypted } from '../utils/secret-codec.js';

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
      // No existing auth settings
      db.select.mockReturnValue(mockDbChain([]));

      await service.initialize();

      expect(db.insert).toHaveBeenCalled();
      // Verify the inserted value has the expected shape
      const insertChain = db.insert.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.key).toBe('auth');
      const config = valuesCall.value;
      expect(config.mode).toBe('none');
      // Secret fields are encrypted before storage
      expect(isEncrypted(config.apiKey)).toBe(true);
      expect(isEncrypted(config.sessionSecret)).toBe(true);
      expect(config.localBypass).toBe(false);
    });

    it('is idempotent (does not overwrite existing settings)', async () => {
      // Auth settings already exist
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: { mode: 'none', apiKey: 'existing' } }]));

      await service.initialize();

      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('createUser', () => {
    it('hashes password with scrypt, stores in users table', async () => {
      // No existing user
      db.select.mockReturnValue(mockDbChain([]));

      await service.createUser('admin', 'password123');

      expect(db.insert).toHaveBeenCalled();
      const insertChain = db.insert.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.username).toBe('admin');
      // Password hash should be salt:hash format
      expect(valuesCall.passwordHash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    });

    it('rejects when user already exists', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: 'x:y' }]));

      await expect(service.createUser('admin', 'password123')).rejects.toThrow('User already exists');
    });
  });

  describe('verifyCredentials', () => {
    it('returns user on valid credentials', async () => {
      // First create a user to get a real hash
      db.select.mockReturnValueOnce(mockDbChain([])); // createUser check
      await service.createUser('admin', 'password123');
      const insertChain = db.insert.mock.results[0].value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      // Now verify — return the stored user
      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));
      const result = await service.verifyCredentials('admin', 'password123');
      expect(result).toEqual({ username: 'admin' });
    });

    it('returns null on invalid password', async () => {
      // Create user first to get real hash
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'password123');
      const insertChain = db.insert.mock.results[0].value;
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
  });

  describe('updateLocalBypass', () => {
    it('updateLocalBypass(true) sets config.localBypass=true and preserves apiKey and sessionSecret', async () => {
      const authConfig = { mode: 'none' as const, apiKey: 'original-key', sessionSecret: 'original-secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await service.updateLocalBypass(true);

      const insertChain = db.insert.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.key).toBe('auth');
      const stored = valuesCall.value as { mode: string; apiKey: string; sessionSecret: string; localBypass: boolean };
      expect(stored.localBypass).toBe(true);
      expect(isEncrypted(stored.apiKey)).toBe(true);
      expect(isEncrypted(stored.sessionSecret)).toBe(true);
    });

    it('updateLocalBypass(false) sets config.localBypass=false and preserves apiKey and sessionSecret', async () => {
      const authConfig = { mode: 'none' as const, apiKey: 'original-key', sessionSecret: 'original-secret', localBypass: true };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));
      db.insert.mockReturnValue(mockDbChain(undefined));

      await service.updateLocalBypass(false);

      const insertChain = db.insert.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      const stored = valuesCall.value as { mode: string; apiKey: string; sessionSecret: string; localBypass: boolean };
      expect(stored.localBypass).toBe(false);
      expect(isEncrypted(stored.apiKey)).toBe(true);
      expect(isEncrypted(stored.sessionSecret)).toBe(true);
    });
  });

  describe('changePassword', () => {
    it('succeeds with correct current password', async () => {
      // Create user
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const insertChain = db.insert.mock.results[0].value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      // changePassword calls verifyCredentials first (select), then update
      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));

      await expect(service.changePassword('admin', 'oldpassword', 'newpassword')).resolves.not.toThrow();
      expect(db.update).toHaveBeenCalled();
    });

    it('timingSafeEqual is called during verifyCredentials (not short-circuited on wrong password)', async () => {
      // Create a real user to obtain a valid password hash
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'correctpass');
      const insertChain = db.insert.mock.results[0].value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      // Verify with wrong password — timingSafeEqual must still be called (not short-circuited)
      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));
      vi.clearAllMocks();
      const result = await service.verifyCredentials('admin', 'wrongpass');

      expect(result).toBeNull();
      expect(timingSafeEqual).toHaveBeenCalled();
    });
    it('rejects with incorrect current password', async () => {
      // Create user
      db.select.mockReturnValueOnce(mockDbChain([]));
      await service.createUser('admin', 'oldpassword');
      const insertChain = db.insert.mock.results[0].value;
      const storedHash = insertChain.values.mock.calls[0][0].passwordHash;

      db.select.mockReturnValue(mockDbChain([{ id: 1, username: 'admin', passwordHash: storedHash }]));

      await expect(service.changePassword('admin', 'wrongpassword', 'newpassword'))
        .rejects.toThrow('Current password is incorrect');
    });
  });

  describe('updateMode', () => {
    it('rejects forms/basic when no user exists', async () => {
      // No users
      db.select
        .mockReturnValueOnce(mockDbChain([])) // user count check
        ;

      await expect(service.updateMode('forms')).rejects.toThrow('Cannot enable auth mode without credentials configured');
      await expect(service.updateMode('basic')).rejects.toThrow('Cannot enable auth mode without credentials configured');
    });

    it('allows switching to "none" without user', async () => {
      // Return auth config for getAuthConfig
      const authConfig = { mode: 'forms', apiKey: 'test-key', sessionSecret: 'test-secret', localBypass: false };
      db.select.mockReturnValue(mockDbChain([{ key: 'auth', value: authConfig }]));

      const result = await service.updateMode('none');
      expect(result.mode).toBe('none');
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

      // Assert setAuthConfig was called with mode: 'none' and preserved apiKey/sessionSecret/localBypass
      const insertChain = db.insert.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.key).toBe('auth');
      const storedConfig = valuesCall.value as { mode: string; apiKey: string; sessionSecret: string; localBypass: boolean };
      expect(storedConfig.mode).toBe('none');
      expect(isEncrypted(storedConfig.apiKey)).toBe(true);      // apiKey preserved (re-encrypted)
      expect(isEncrypted(storedConfig.sessionSecret)).toBe(true); // sessionSecret preserved (re-encrypted)
      expect(storedConfig.localBypass).toBe(false);              // localBypass preserved
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

      // Decode payload
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
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
      expect(result!.shouldRenew).toBe(false); // Just created, not past 50%
    });

    it('verifySessionCookie returns null for tampered signature', () => {
      const cookie = service.createSessionCookie('admin', secret);
      const tampered = cookie.slice(0, -5) + 'XXXXX';

      const result = service.verifySessionCookie(tampered, secret);
      expect(result).toBeNull();
    });

    it('verifySessionCookie returns null for expired cookie', () => {
      // Create a cookie with past expiry by manipulating time
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
      // Build a cookie with valid HMAC signature but non-JSON payload
      const corruptedB64 = Buffer.from('not-valid-json!!!').toString('base64url');
      const sig = createHmac('sha256', secret).update(corruptedB64).digest('base64url');
      const cookie = `${corruptedB64}.${sig}`;

      expect(service.verifySessionCookie(cookie, secret)).toBeNull();
    });

    it('sliding expiry: cookie >50% through TTL flagged for renewal', () => {
      const now = Date.now();
      // Create cookie issued 4 days ago (>50% of 7-day TTL)
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
});
