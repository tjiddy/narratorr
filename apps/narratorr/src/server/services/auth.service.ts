import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { settings, users } from '../../db/schema.js';
import type { AuthMode } from '../../shared/schemas.js';

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

    await this.db
      .insert(settings)
      .values({ key: 'auth', value: authConfig as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: authConfig as unknown },
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
    return result[0].value as AuthConfig;
  }

  private async setAuthConfig(config: AuthConfig): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: 'auth', value: config as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: config as unknown },
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
        throw new Error('Cannot enable auth mode without credentials configured');
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

  async createUser(username: string, password: string): Promise<void> {
    const existing = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      throw new Error('User already exists');
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

    const user = result[0];
    const [saltHex, hashHex] = user.passwordHash.split(':');
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
      throw new Error('Current password is incorrect');
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
    return config.apiKey === key;
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
    if (parts.length !== 2) {
      this.log.debug('Auth: malformed session cookie');
      return null;
    }

    const [payloadB64, signature] = parts;
    const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

    // Timing-safe comparison for signatures
    if (signature.length !== expectedSig.length) {
      this.log.debug('Auth: cookie signature length mismatch');
      return null;
    }
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (!timingSafeEqual(sigBuf, expectedBuf)) {
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
