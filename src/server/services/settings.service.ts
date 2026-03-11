import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { settings } from '../../db/schema.js';
import {
  type AppSettings,
  type SettingsCategory,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
} from '../../shared/schemas.js';
import { encryptFields, decryptFields, isSentinel, getKey, type SecretEntity } from '../utils/secret-codec.js';

export type { AppSettings };

/** Categories that contain secret fields (only categories managed by SettingsService). */
const SECRET_CATEGORIES: Partial<Record<SettingsCategory, SecretEntity>> = {
  network: 'network',
};

function parseCategory<K extends SettingsCategory>(
  key: K,
  raw: unknown,
  log: FastifyBaseLogger,
): AppSettings[K] {
  if (raw === undefined || raw === null) {
    return DEFAULT_SETTINGS[key];
  }
  const schema = CATEGORY_SCHEMAS[key];
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data as AppSettings[K];
  }
  log.warn({ category: key, errors: result.error.issues }, 'Settings parse failed, using defaults');
  return DEFAULT_SETTINGS[key];
}

export class SettingsService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  async get<K extends SettingsCategory>(key: K): Promise<AppSettings[K]> {
    const result = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);

    if (result.length === 0) {
      return DEFAULT_SETTINGS[key];
    }

    let raw = result[0].value;
    // Decrypt secret fields before Zod parsing
    const entity = SECRET_CATEGORIES[key];
    if (entity && raw && typeof raw === 'object') {
      raw = decryptFields(entity, { ...(raw as Record<string, unknown>) }, getKey());
    }

    return parseCategory(key, raw, this.log);
  }

  async getAll(): Promise<AppSettings> {
    const results = await this.db.select().from(settings);

    const settingsMap = new Map(results.map((r) => [r.key, r.value]));

    return Object.fromEntries(
      SETTINGS_CATEGORIES.map((key) => {
        let raw = settingsMap.get(key);
        const entity = SECRET_CATEGORIES[key];
        if (entity && raw && typeof raw === 'object') {
          raw = decryptFields(entity, { ...(raw as Record<string, unknown>) }, getKey());
        }
        return [key, parseCategory(key, raw, this.log)];
      }),
    ) as AppSettings;
  }

  async set<K extends SettingsCategory>(key: K, value: AppSettings[K]): Promise<void> {
    let dbValue: unknown = value;
    // Handle sentinel passthrough and encryption for secret categories
    const entity = SECRET_CATEGORIES[key];
    if (entity && dbValue && typeof dbValue === 'object') {
      const incoming = { ...(dbValue as Record<string, unknown>) };
      // If any secret field is "********", preserve the existing encrypted value
      const existing = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
      if (existing[0]) {
        const existingValue = (existing[0].value ?? {}) as Record<string, unknown>;
        for (const [field, val] of Object.entries(incoming)) {
          if (typeof val === 'string' && isSentinel(val)) {
            incoming[field] = existingValue[field]; // Keep existing (encrypted) value
          }
        }
      }
      dbValue = encryptFields(entity, incoming, getKey());
    }

    await this.db
      .insert(settings)
      .values({ key, value: dbValue })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: dbValue },
      });
    this.log.info({ category: key }, 'Settings updated');
  }

  async update(partial: Partial<AppSettings>): Promise<AppSettings> {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        await this.set(key as SettingsCategory, value);
      }
    }
    return this.getAll();
  }
}
