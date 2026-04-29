import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { indexerSettingsSchemas } from '../../shared/schemas/indexer.js';
import { downloadClientSettingsSchemas } from '../../shared/schemas/download-client.js';
import { notifierSettingsSchemas } from '../../shared/schemas/notifier.js';
import { importListSettingsSchemas } from '../../shared/schemas/import-list.js';

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
  | 'network'
  | 'importList'
  | 'notifier';

// Notifier secret fields are flat across all subtypes (encryptFields skips
// missing fields harmlessly). When adding a new notifier subtype with a secret
// field, append it here. Contributors per subtype:
//   webhook:  url, headers           discord:  webhookUrl
//   slack:    webhookUrl             telegram: botToken
//   email:    smtpPass               pushover: pushoverToken
//   gotify:   gotifyToken            (script/ntfy: no secrets in current schema)
const SECRET_FIELDS: Record<SecretEntity, readonly string[]> = {
  indexer: ['apiKey', 'apiUrl', 'flareSolverrUrl', 'mamId'],
  downloadClient: ['password', 'apiKey'],
  prowlarr: ['apiKey'],
  auth: ['sessionSecret', 'apiKey'],
  network: ['proxyUrl'],
  importList: ['apiKey'],
  notifier: ['url', 'webhookUrl', 'botToken', 'smtpPass', 'pushoverToken', 'gotifyToken', 'headers'],
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

// ─── Sentinel Passthrough ────────────────────────────────────────────────────

/**
 * Replace sentinel values ('********') in `incoming` with the corresponding
 * values from `existing`. Non-sentinel values pass through unchanged.
 * Mutates and returns `incoming`.
 */
export function resolveSentinelFields(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === 'string' && isSentinel(value)) {
      incoming[key] = existing?.[key];
    }
  }
  return incoming;
}

// ─── Field-level operations ──────────────────────────────────────────────────

export function getSecretFieldNames(entity: SecretEntity): readonly string[] {
  return SECRET_FIELDS[entity] ?? [];
}

// ─── Test-mode schema (sentinel-aware) ───────────────────────────────────────

const PER_TYPE_SETTINGS_MAPS: Partial<Record<SecretEntity, Record<string, z.ZodTypeAny>>> = {
  indexer: indexerSettingsSchemas,
  downloadClient: downloadClientSettingsSchemas,
  notifier: notifierSettingsSchemas,
  importList: importListSettingsSchemas,
};

function loosenSettingsSchema(
  schema: z.ZodTypeAny,
  secretFields: readonly string[],
): z.ZodTypeAny {
  if (!(schema instanceof z.ZodObject)) return schema;
  const obj = schema as z.ZodObject<z.ZodRawShape>;
  const shape = obj.shape as Record<string, z.ZodTypeAny>;
  const overrides: Record<string, z.ZodTypeAny> = {};
  for (const field of secretFields) {
    const original = shape[field];
    if (!original) continue;
    overrides[field] = z.union([z.literal(SENTINEL), original]);
  }
  if (Object.keys(overrides).length === 0) return schema;
  // safeExtend is the public API for overriding keys on objects that may carry
  // chained refinements (e.g. Hardcover's listType/shelfId rule). It preserves
  // strict mode and refinement checks; .extend() throws when overwriting keys
  // on schemas with refinements.
  return obj.safeExtend(overrides);
}

/**
 * Build a sentinel-aware test-mode schema for a CRUD entity's `/test` endpoint.
 *
 * Loosens the per-type settings schemas so each registered secret field
 * accepts either the sentinel `'********'` or its original validator. Outer
 * fields (name/type/priority/etc.) keep their strict validators. Adds an
 * optional `id` field for resolving sentinels against saved settings.
 *
 * Per-entity validation is rebuilt from the per-type settings map (not
 * introspected from the create schema's superRefine), so adapter-specific
 * validators like Hardcover's listType/shelfId rule are preserved on the
 * loosened secret field.
 */
export function makeTestSchema<S extends z.ZodTypeAny>(
  createSchema: S,
  secretEntity: SecretEntity,
): z.ZodTypeAny {
  if (!(createSchema instanceof z.ZodObject)) return createSchema;
  const outer = createSchema as z.ZodObject<z.ZodRawShape>;
  const withId = outer.extend({ id: z.number().int().positive().optional() });

  const settingsMap = PER_TYPE_SETTINGS_MAPS[secretEntity];
  const secretFields = getSecretFieldNames(secretEntity);
  if (!settingsMap) return withId;

  const perTypeMap: Record<string, z.ZodTypeAny> = {};
  for (const [type, schema] of Object.entries(settingsMap)) {
    perTypeMap[type] = secretFields.length === 0
      ? schema
      : loosenSettingsSchema(schema, secretFields);
  }

  return withId.superRefine((data, ctx) => {
    const obj = data as { type?: string; settings?: Record<string, unknown> };
    if (typeof obj.type !== 'string' || !obj.settings) return;
    const schema = perTypeMap[obj.type];
    if (!schema) return;
    const result = schema.safeParse(obj.settings);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['settings', ...issue.path] });
      }
      return;
    }
    obj.settings = result.data as Record<string, unknown>;
  });
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
    if (!(field in settings)) continue;
    const value = settings[field];
    // Preserve empty string, null, and undefined — only mask non-empty values
    if (value === '' || value == null) continue;
    settings[field] = SENTINEL;
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
