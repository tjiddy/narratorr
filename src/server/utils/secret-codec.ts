import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { indexerSettingsSchemas } from '../../shared/schemas/indexer.js';
import { downloadClientSettingsSchemas } from '../../shared/schemas/download-client.js';
import { notifierSettingsSchemas } from '../../shared/schemas/notifier.js';
import { importListSettingsSchemas } from '../../shared/schemas/import-list.js';
import { connectorSettingsSchemas } from '../../shared/schemas/connector.js';

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
  | 'auth'
  | 'network'
  | 'metadata'
  | 'importList'
  | 'notifier'
  | 'connector';

// Notifier secret fields are flat across all subtypes (encryptFields skips
// missing fields harmlessly). When adding a new notifier subtype with a secret
// field, append it here. Contributors per subtype:
//   webhook:  url, headers           discord:  webhookUrl
//   slack:    webhookUrl             telegram: botToken
//   email:    smtpPass               pushover: pushoverToken, pushoverUser
//   gotify:   gotifyToken            ntfy:     ntfyTopic, ntfyAccessToken
//   (script: no secrets in current schema)
// pushoverUser (a documented-private user key) and ntfyTopic (the topic name IS
// the publish/subscribe capability on public ntfy servers) are credential-shaped
// and registered here so they are encrypted at rest and masked in responses (#1307).
// ntfyAccessToken is the Bearer token for protected ntfy topics (#1607).
const SECRET_FIELDS: Record<SecretEntity, readonly string[]> = {
  indexer: ['apiKey', 'apiUrl', 'flareSolverrUrl', 'mamId'],
  downloadClient: ['password', 'apiKey'],
  auth: ['sessionSecret', 'apiKey'],
  network: ['proxyUrl'],
  metadata: ['hardcoverApiKey'],
  importList: ['apiKey'],
  notifier: ['url', 'webhookUrl', 'botToken', 'smtpPass', 'pushoverToken', 'pushoverUser', 'gotifyToken', 'ntfyTopic', 'ntfyAccessToken', 'headers'],
  // baseUrl is registered alongside apiKey/token per the issue spec: connector
  // apiKey/token/baseUrl are encrypted at rest and masked in responses,
  // consistent with operator-configured integrations like indexer apiUrl (#1491).
  // token is the Plex secret (#1492); flat across subtypes (encryptFields skips
  // fields not present in a given connector's settings).
  connector: ['baseUrl', 'apiKey', 'token'],
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

/** Thrown by `resolveSentinelFields` when a sentinel appears on a key that
 *  is not in the entity's secret-field allowlist. Callers (services or route
 *  preflight) translate this into HTTP 400. */
export class SentinelOnNonSecretFieldError extends Error {
  constructor(public readonly field: string) {
    super(`Sentinel value is not allowed on non-secret field: ${field}`);
    this.name = 'SentinelOnNonSecretFieldError';
  }
}

/**
 * Replace sentinel values ('********') in `incoming` with the corresponding
 * values from `existing`, scoped to the given secret-field allowlist. A
 * sentinel on any key NOT in `allowlist` throws `SentinelOnNonSecretFieldError`
 * — callers must handle or surface that as HTTP 400. Non-sentinel values pass
 * through unchanged. Mutates and returns `incoming`.
 */
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
  // safeExtend is the public API for overriding keys on objects that may carry
  // chained refinements (e.g. Hardcover's listType/shelfId rule, connector's
  // baseUrl URL refinement). It preserves strict mode and refinement checks;
  // .extend() throws when overwriting keys on schemas with refinements.
  return obj.safeExtend(overrides);
}

/**
 * Loosen every per-type settings schema in a map so each registered secret
 * field accepts the masked `'********'` sentinel OR its original validator. Used
 * to build sentinel-aware update schemas for routes that pass the per-type map
 * directly (e.g. the connector PUT route). Returns a new map; inputs untouched.
 */
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
 *
 * `settingsMapOverride` swaps in a different per-type settings map than the
 * entity default — e.g. the connector `/targets` route passes the
 * targets-scoped map (selector field optional) so a new connector can fetch its
 * dropdown before the selector is known, while the strict map governs
 * create/update/test (#1523).
 */
export function makeTestSchema<S extends z.ZodTypeAny>(
  createSchema: S,
  secretEntity: SecretEntity,
  settingsMapOverride?: Record<string, z.ZodTypeAny>,
): z.ZodTypeAny {
  if (!(createSchema instanceof z.ZodObject)) return createSchema;
  const outer = createSchema as z.ZodObject<z.ZodRawShape>;
  // Rebuild the outer object from its shape so the create schema's own per-type
  // `superRefine` (strict `validateSettingsPerType`) is dropped — this function
  // re-derives per-type validation from the loosened settings map below, and
  // re-running the strict refinement would reject a sentinel on any secret field
  // that carries a format refinement (e.g. connector `baseUrl`'s URL check).
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
  // Opportunistic decrypt: decrypt ANY `$ENC$`-prefixed string value regardless
  // of SECRET_FIELDS membership. This rollback-proofs the read path (#1357) — a
  // value encrypted by a build that registered a field the running build does
  // not (e.g. after a rollback past the registration) is still decrypted rather
  // than handed to an adapter as raw `$ENC$` ciphertext. Decrypting a value the
  // running build doesn't consider secret is harmless; encrypt/mask stay
  // registry-scoped so no field outside the registry is ever encrypted or masked.
  //
  // Decryption failures (malformed / undersized / non-base64 blobs, auth-tag
  // mismatch) pass through unchanged via try/catch — read-path callers
  // (notifier.service `decryptRow` et al.) invoke this without their own
  // try/catch, so a corrupt blob must never crash a route handler.
  //
  // Diagnostic (#1404): a silent passthrough is correct but undiagnosable — if
  // `secret.key` is lost/regenerated (volume wipe, manual deletion), every
  // stored secret stops decrypting and the only symptom is mysterious downstream
  // auth failures with nothing in the logs. Collect the failed field NAMES (never
  // values) and emit one `warn` per call so the root cause is greppable. Logging
  // is owned here — the single point that touches plaintext — so the
  // "never log values" guarantee holds uniformly across all callers.
  const failedFields: string[] = [];
  for (const [field, value] of Object.entries(settings)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      try {
        settings[field] = decrypt(value, key);
      } catch {
        // Passthrough: leave the original `$ENC$` value untouched on any failure.
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
