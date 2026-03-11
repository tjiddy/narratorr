import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────

const PREFIX = '$ENC$';
const SENTINEL = '********';
const REDACTED = '[REDACTED]';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended
const AUTH_TAG_LENGTH = 16;
const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

// ─── Secret Fields Registry ──────────────────────────────────────────────────

export type SecretEntity =
  | 'indexer'
  | 'downloadClient'
  | 'prowlarr'
  | 'auth'
  | 'network';

const SECRET_FIELDS: Record<SecretEntity, readonly string[]> = {
  indexer: ['apiKey', 'flareSolverrUrl', 'mamId'],
  downloadClient: ['password', 'apiKey'],
  prowlarr: ['apiKey'],
  auth: ['sessionSecret', 'apiKey'],
  network: ['proxyUrl'],
};

// ─── Low-level encrypt / decrypt ─────────────────────────────────────────────

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: $ENC$<iv><authTag><ciphertext> all base64
  const payload = Buffer.concat([iv, authTag, encrypted]);
  return PREFIX + payload.toString('base64');
}

export function decrypt(encryptedValue: string, key: Buffer): string {
  if (!encryptedValue.startsWith(PREFIX)) {
    throw new Error('Value is not encrypted (missing $ENC$ prefix)');
  }
  const payload = Buffer.from(encryptedValue.slice(PREFIX.length), 'base64');
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function isSentinel(value: string): boolean {
  return value === SENTINEL;
}

// ─── Field-level operations ──────────────────────────────────────────────────

function getSecretFieldNames(entity: SecretEntity): readonly string[] {
  return SECRET_FIELDS[entity] ?? [];
}

export function encryptFields(
  entity: SecretEntity,
  settings: Record<string, unknown>,
  key: Buffer,
): Record<string, unknown> {
  const fields = getSecretFieldNames(entity);
  for (const field of fields) {
    if (!(field in settings)) continue;
    const value = settings[field];
    if (value == null) continue;
    if (typeof value === 'string' && !isEncrypted(value)) {
      settings[field] = encrypt(value, key);
    }
  }
  return settings;
}

export function decryptFields(
  entity: SecretEntity,
  settings: Record<string, unknown>,
  key: Buffer,
): Record<string, unknown> {
  const fields = getSecretFieldNames(entity);
  for (const field of fields) {
    if (!(field in settings)) continue;
    const value = settings[field];
    if (typeof value === 'string' && isEncrypted(value)) {
      settings[field] = decrypt(value, key);
    }
  }
  return settings;
}

export function maskFields(
  entity: SecretEntity,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const fields = getSecretFieldNames(entity);
  for (const field of fields) {
    if (!(field in settings) && !fields.includes(field)) continue;
    // Mask even null/undefined — the field exists in the registry
    if (field in settings) {
      settings[field] = SENTINEL;
    }
  }
  return settings;
}

export function redactSecrets(
  entity: SecretEntity,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const fields = getSecretFieldNames(entity);
  for (const field of fields) {
    if (!(field in settings)) continue;
    settings[field] = REDACTED;
  }
  return settings;
}

// ─── Singleton Key ───────────────────────────────────────────────────────────

let _encryptionKey: Buffer | null = null;

/** Initialize the module-level encryption key. Call once at startup. */
export function initializeKey(key: Buffer): void {
  _encryptionKey = key;
}

/** Get the initialized encryption key. Throws if not initialized. */
export function getKey(): Buffer {
  if (!_encryptionKey) {
    throw new Error('Encryption key not initialized — call initializeKey() at startup');
  }
  return _encryptionKey;
}

/** Reset key (for testing only). */
export function _resetKey(): void {
  _encryptionKey = null;
}

// ─── Key Management ──────────────────────────────────────────────────────────

function validateHexKey(hex: string, source: string): Buffer {
  if (!HEX_KEY_REGEX.test(hex)) {
    throw new Error(
      `Invalid ${source}: must be a 64-character hex string (32 bytes). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(hex, 'hex');
}

export interface KeyLoadResult {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
}

export function loadEncryptionKey(envValue: string | undefined, configPath: string): KeyLoadResult {
  // 1. Try env var
  if (envValue && envValue.length > 0) {
    return { key: validateHexKey(envValue, 'NARRATORR_SECRET_KEY'), source: 'env' };
  }

  // 2. Try key file
  const keyFile = path.join(configPath, 'secret.key');
  if (fs.existsSync(keyFile)) {
    const content = fs.readFileSync(keyFile, 'utf8').trim();
    return { key: validateHexKey(content, `key in ${keyFile}`), source: 'file' };
  }

  // 3. Generate new key
  const newKey = randomBytes(32);
  const hex = newKey.toString('hex');
  fs.mkdirSync(configPath, { recursive: true });
  fs.writeFileSync(keyFile, hex + '\n', { mode: 0o600 });
  return { key: newKey, source: 'generated' };
}
