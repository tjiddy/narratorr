import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { indexerSettingsSchemas } from '@shared/schemas/indexer.js';
import { downloadClientSettingsSchemas } from '@shared/schemas/download-client.js';
import { notifierSettingsSchemas } from '@shared/schemas/notifier.js';
import { importListSettingsSchemas } from '@shared/schemas/import-list.js';
import { connectorSettingsSchemas } from '@shared/schemas/connector.js';

const PREFIX = '$ENC$';
const SENTINEL = '********';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Recommended GCM nonce length.
const AUTH_TAG_LENGTH = 16;
const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

export type SecretEntity =
  | 'indexer'
  | 'downloadClient'
  | 'auth'
  | 'network'
  | 'metadata'
  | 'importList'
  | 'notifier'
  | 'connector';

// Flat across notifier subtypes; missing fields are ignored. Add every new subtype secret here.
// pushoverUser and public-server ntfyTopic values are credentials despite their names.
const SECRET_FIELDS: Record<SecretEntity, readonly string[]> = {
  indexer: ['apiKey', 'apiUrl', 'flareSolverrUrl', 'mamId'],
  downloadClient: ['password', 'apiKey'],
  auth: ['sessionSecret', 'apiKey'],
  network: ['proxyUrl'],
  metadata: ['hardcoverApiKey'],
  importList: ['apiKey'],
  notifier: ['url', 'webhookUrl', 'botToken', 'smtpPass', 'pushoverToken', 'pushoverUser', 'gotifyToken', 'ntfyTopic', 'ntfyAccessToken', 'headers'],
  // Connector baseUrl is intentionally encrypted and masked alongside credentials.
  connector: ['baseUrl', 'apiKey', 'token'],
};

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

export class SentinelOnNonSecretFieldError extends Error {
  constructor(public readonly field: string) {
    super(`Sentinel value is not allowed on non-secret field: ${field}`);
    this.name = 'SentinelOnNonSecretFieldError';
  }
}

/** Replaces sentinel values in place for the allowlist; rejects a sentinel on any other key. */
export function resolveSentinelFields(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
  allowlist: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(allowlist);
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === 'string' && isSentinel(value)) {
      if (!allowed.has(key)) {
        throw new SentinelOnNonSecretFieldError(key);
      }
      incoming[key] = existing?.[key];
    }
  }
  return incoming;
}

export function getSecretFieldNames(entity: SecretEntity): readonly string[] {
  return SECRET_FIELDS[entity] ?? [];
}

const PER_TYPE_SETTINGS_MAPS: Partial<Record<SecretEntity, Record<string, z.ZodTypeAny>>> = {
  indexer: indexerSettingsSchemas,
  downloadClient: downloadClientSettingsSchemas,
  notifier: notifierSettingsSchemas,
  importList: importListSettingsSchemas,
  connector: connectorSettingsSchemas,
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
  // safeExtend preserves strictness/refinements; extend throws when refined keys are overridden.
  return obj.safeExtend(overrides);
}

export function loosenSettingsSchemas(
  settingsMap: Record<string, z.ZodTypeAny>,
  secretEntity: SecretEntity,
): Record<string, z.ZodTypeAny> {
  const secretFields = getSecretFieldNames(secretEntity);
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [type, schema] of Object.entries(settingsMap)) {
    out[type] = secretFields.length === 0 ? schema : loosenSettingsSchema(schema, secretFields);
  }
  return out;
}

/** Builds a sentinel-aware CRUD test schema; an override supplies a route-specific settings map. */
export function makeTestSchema<S extends z.ZodTypeAny>(
  createSchema: S,
  secretEntity: SecretEntity,
  settingsMapOverride?: Record<string, z.ZodTypeAny>,
): z.ZodTypeAny {
  if (!(createSchema instanceof z.ZodObject)) return createSchema;
  const outer = createSchema as z.ZodObject<z.ZodRawShape>;
  // Rebuild from shape to drop strict superRefine; the loosened map below revalidates sentinels.
  const withId = z.object(outer.shape).extend({ id: z.number().int().positive().optional() });

  const settingsMap = settingsMapOverride ?? PER_TYPE_SETTINGS_MAPS[secretEntity];
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
  logger?: FastifyBaseLogger,
): Record<string, unknown> {
  // Decrypt every marked value, not just registered fields, so rollback never exposes ciphertext to adapters.
  // Failures pass ciphertext through and log field names only; never log secret values.
  const failedFields: string[] = [];
  for (const [field, value] of Object.entries(settings)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        settings[field] = decrypt(value, key);
      } catch {
        failedFields.push(field);
      }
    }
  }
  if (failedFields.length > 0) {
    logger?.warn({ entity, failedFields }, 'Failed to decrypt stored secret fields — check secret.key');
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
    if (value === '' || value == null) continue;
    settings[field] = SENTINEL;
  }
  return settings;
}

let _encryptionKey: Buffer | null = null;

export function initializeKey(key: Buffer): void {
  _encryptionKey = key;
}

export function getKey(): Buffer {
  if (!_encryptionKey) {
    throw new Error('Encryption key not initialized — call initializeKey() at startup');
  }
  return _encryptionKey;
}

export function _resetKey(): void {
  _encryptionKey = null;
}

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
  if (envValue && envValue.length > 0) {
    return { key: validateHexKey(envValue, 'NARRATORR_SECRET_KEY'), source: 'env' };
  }

  const keyFile = path.join(configPath, 'secret.key');
  if (fs.existsSync(keyFile)) {
    const content = fs.readFileSync(keyFile, 'utf8').trim();
    return { key: validateHexKey(content, `key in ${keyFile}`), source: 'file' };
  }

  const newKey = randomBytes(32);
  const hex = newKey.toString('hex');
  fs.mkdirSync(configPath, { recursive: true });
  fs.writeFileSync(keyFile, hex + '\n', { mode: 0o600 });
  return { key: newKey, source: 'generated' };
}
