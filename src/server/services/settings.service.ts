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
import { encryptFields, decryptFields, resolveSentinelFields, getKey, type SecretEntity } from '../utils/secret-codec.js';

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
      const existing = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
      resolveSentinelFields(incoming, (existing[0]?.value ?? {}) as Record<string, unknown>);
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
        const category = key as SettingsCategory;
        const existing = await this.get(category);
        const merged = { ...existing, ...value };
        await this.set(category, merged);
      }
    }
    return this.getAll();
  }
}
