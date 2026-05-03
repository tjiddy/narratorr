import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { settings, users } from '../../db/schema.js';
import { authModeSchema, type AuthMode } from '../../shared/schemas.js';
import { encryptFields, decryptFields, getKey } from '../utils/secret-codec.js';

const authConfigSchema = z.object({
  mode: authModeSchema,
  apiKey: z.string(),
  sessionSecret: z.string(),
  localBypass: z.boolean(),
});

export interface AuthConfig {
  mode: AuthMode;
  apiKey: string;
  sessionSecret: string;
  localBypass: boolean;
}

export interface AuthStatus {
  mode: AuthMode;
  hasUser: boolean;
  username?: string;
  localBypass: boolean;
}

export interface AuthPublicConfig {
  mode: AuthMode;
  apiKey: string;
  localBypass: boolean;
}

interface SessionPayload {
  username: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionVerifyResult {
  payload: SessionPayload;
  shouldRenew: boolean;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_KEYLEN = 64;

function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export class AuthService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  /** Auto-generate default auth settings if none exist. Idempotent. */
  async initialize(): Promise<void> {
    const existing = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'auth'))
      .limit(1);

    if (existing.length > 0) {
      this.log.debug('Auth settings already initialized');
      return;
    }

    const authConfig: AuthConfig = {
      mode: 'none',
      apiKey: randomUUID(),
      sessionSecret: randomBytes(32).toString('hex'),
      localBypass: false,
    };

    const encrypted = encryptFields('auth', { ...authConfig } as Record<string, unknown>, getKey());
    await this.db
      .insert(settings)
      .values({ key: 'auth', value: encrypted as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encrypted as unknown },
      });

    this.log.info('Auth settings initialized with default configuration');
  }

  // ─── Config ────────────────────────────────────────────────────────

  private async getAuthConfig(): Promise<AuthConfig> {
    const result = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'auth'))
      .limit(1);

    if (result.length === 0) {
      throw new Error('Auth settings not initialized — call initialize() first');
    }
    const raw = result[0]!.value as Record<string, unknown>;
    return authConfigSchema.parse(decryptFields('auth', { ...raw }, getKey()));
  }

  private async setAuthConfig(config: AuthConfig): Promise<void> {
    const encrypted = encryptFields('auth', { ...config } as Record<string, unknown>, getKey());
    await this.db
      .insert(settings)
      .values({ key: 'auth', value: encrypted as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encrypted as unknown },
      });
  }

  /** Public status — no secrets exposed. */
  async getStatus(): Promise<AuthStatus> {
    const config = await this.getAuthConfig();
    const userRows = await this.db.select().from(users).limit(1);
    return {
      mode: config.mode,
      hasUser: userRows.length > 0,
      username: userRows[0]?.username,
      localBypass: config.localBypass,
    };
  }

  /** Protected config — includes API key but never sessionSecret. */
  async getConfig(): Promise<AuthPublicConfig> {
    const config = await this.getAuthConfig();
    return {
      mode: config.mode,
      apiKey: config.apiKey,
      localBypass: config.localBypass,
    };
  }

  async updateMode(mode: AuthMode): Promise<AuthPublicConfig> {
    if (mode !== 'none') {
      const userCount = await this.db.select().from(users).limit(1);
      if (userCount.length === 0) {
        throw new AuthConfigError();
      }
    }

    const config = await this.getAuthConfig();
    config.mode = mode;
    await this.setAuthConfig(config);
    this.log.info({ mode }, 'Auth mode updated');
    return { mode: config.mode, apiKey: config.apiKey, localBypass: config.localBypass };
  }

  async updateLocalBypass(enabled: boolean): Promise<AuthPublicConfig> {
    const config = await this.getAuthConfig();
    config.localBypass = enabled;
    await this.setAuthConfig(config);
    this.log.info({ localBypass: enabled }, 'Local bypass updated');
    return { mode: config.mode, apiKey: config.apiKey, localBypass: config.localBypass };
  }

  async updateConfig(updates: { mode?: AuthMode; localBypass?: boolean }): Promise<AuthPublicConfig> {
    if (updates.mode !== undefined) {
      // updateMode has its own validation
      await this.updateMode(updates.mode);
    }
    if (updates.localBypass !== undefined) {
      await this.updateLocalBypass(updates.localBypass);
    }
    return this.getConfig();
  }

  // ─── Users / Credentials ──────────────────────────────────────────

  /** Delete all users and reset auth mode to `none`. Only call when AUTH_BYPASS is active. */
  async deleteCredentials(): Promise<void> {
    const userRows = await this.db.select().from(users).limit(1);
    if (userRows.length === 0) {
      throw new NoCredentialsError();
    }

    await this.db.delete(users);

    const config = await this.getAuthConfig();
    config.mode = 'none';
    await this.setAuthConfig(config);
    this.log.info('Credentials deleted and auth mode reset to none');
  }

  async createUser(username: string, password: string): Promise<void> {
    const existing = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      throw new UserExistsError();
    }

    const salt = randomBytes(16);
    const hash = await hashPassword(password, salt);
    const passwordHash = `${salt.toString('hex')}:${hash.toString('hex')}`;

    await this.db.insert(users).values({ username, passwordHash });
    this.log.info({ username }, 'User created');
  }

  async hasUser(): Promise<boolean> {
    const result = await this.db.select().from(users).limit(1);
    return result.length > 0;
  }

  async verifyCredentials(username: string, password: string): Promise<{ username: string } | null> {
    const result = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (result.length === 0) {
      this.log.debug({ username }, 'Auth: user not found');
      return null;
    }

    const user = result[0]!;
    const parts = user.passwordHash.split(':');
    const saltHex = parts[0];
    const hashHex = parts[1];
    if (parts.length !== 2 || saltHex === undefined || hashHex === undefined) {
      // §6.4 — DB has a malformed passwordHash (no `:` separator). Treat as
      // invalid credentials rather than a 500 — prevents an attacker from
      // distinguishing "user exists with corrupt hash" from "wrong password".
      // Logged at warn so operators see it; this should never happen with
      // hashes produced by hashPassword().
      this.log.warn({ username }, 'Auth: malformed passwordHash in DB');
      return null;
    }
    const salt = Buffer.from(saltHex, 'hex');
    const storedHash = Buffer.from(hashHex, 'hex');

    const derivedHash = await hashPassword(password, salt);

    if (!timingSafeEqual(storedHash, derivedHash)) {
      this.log.debug({ username }, 'Auth: invalid password');
      return null;
    }

    return { username: user.username };
  }

  async changePassword(username: string, currentPassword: string, newPassword: string, newUsername?: string): Promise<void> {
    const verified = await this.verifyCredentials(username, currentPassword);
    if (!verified) {
      throw new IncorrectPasswordError();
    }

    const salt = randomBytes(16);
    const hash = await hashPassword(newPassword, salt);
    const passwordHash = `${salt.toString('hex')}:${hash.toString('hex')}`;

    const updates: Record<string, string> = { passwordHash };
    if (newUsername && newUsername !== username) {
      updates.username = newUsername;
    }

    await this.db
      .update(users)
      .set(updates)
      .where(eq(users.username, username));
    this.log.info({ username, newUsername: newUsername || username }, 'Credentials updated');
  }

  // ─── API Key ───────────────────────────────────────────────────────

  async validateApiKey(key: string): Promise<boolean> {
    const config = await this.getAuthConfig();
    // SHA-256 both sides to a fixed length — avoids leaking key length via early
    // length-mismatch return. Buffers are always 32 bytes so timingSafeEqual is safe.
    const expectedHash = createHash('sha256').update(config.apiKey).digest();
    const providedHash = createHash('sha256').update(key).digest();
    return timingSafeEqual(expectedHash, providedHash);
  }

  async regenerateApiKey(): Promise<string> {
    const config = await this.getAuthConfig();
    config.apiKey = randomUUID();
    await this.setAuthConfig(config);
    this.log.info('API key regenerated');
    return config.apiKey;
  }

  // ─── Session Cookie ────────────────────────────────────────────────

  async getSessionSecret(): Promise<string> {
    const config = await this.getAuthConfig();
    return config.sessionSecret;
  }

  createSessionCookie(username: string, secret: string): string {
    const now = Date.now();
    const payload: SessionPayload = {
      username,
      issuedAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');
    return `${payloadB64}.${signature}`;
  }

  verifySessionCookie(cookie: string, secret: string): SessionVerifyResult | null {
    const parts = cookie.split('.');
    const payloadB64 = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || payloadB64 === undefined || signature === undefined) {
      this.log.debug('Auth: malformed session cookie');
      return null;
    }

    const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

    // SHA-256 both sides to a fixed length — avoids leaking signature length via early
    // length-mismatch return. Buffers are always 32 bytes so timingSafeEqual is safe.
    const sigHash = createHash('sha256').update(signature).digest();
    const expectedHash = createHash('sha256').update(expectedSig).digest();
    if (!timingSafeEqual(sigHash, expectedHash)) {
      this.log.debug('Auth: cookie signature mismatch');
      return null;
    }

    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    } catch {
      this.log.debug('Auth: cookie payload parse failed');
      return null;
    }

    const now = Date.now();
    if (now >= payload.expiresAt) {
      this.log.debug({ username: payload.username }, 'Auth: session expired');
      return null;
    }

    // Sliding expiry: renew if >50% through TTL
    const elapsed = now - payload.issuedAt;
    const shouldRenew = elapsed > SESSION_TTL_MS / 2;

    return { payload, shouldRenew };
  }
}

// ─── Typed Error Classes ──────────────────────────────────────────────

export class UserExistsError extends Error {
  readonly code = 'USER_EXISTS' as const;
  constructor() {
    super('User already exists');
    this.name = 'UserExistsError';
  }
}

export class AuthConfigError extends Error {
  readonly code = 'NO_CREDENTIALS' as const;
  constructor() {
    super('Cannot enable auth mode without credentials configured');
    this.name = 'AuthConfigError';
  }
}

export class IncorrectPasswordError extends Error {
  readonly code = 'INCORRECT_PASSWORD' as const;
  constructor() {
    super('Current password is incorrect');
    this.name = 'IncorrectPasswordError';
  }
}

export class NoCredentialsError extends Error {
  readonly code = 'NO_CREDENTIALS' as const;
  constructor() {
    super('No credentials configured');
    this.name = 'NoCredentialsError';
  }
}
