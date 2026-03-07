import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { settings } from '@narratorr/db/schema';
import {
  type AppSettings,
  type SettingsCategory,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
} from '../../shared/schemas.js';

export type { AppSettings };

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

    return parseCategory(key, result[0].value, this.log);
  }

  async getAll(): Promise<AppSettings> {
    const results = await this.db.select().from(settings);

    const settingsMap = new Map(results.map((r) => [r.key, r.value]));

    return Object.fromEntries(
      SETTINGS_CATEGORIES.map((key) => [
        key,
        parseCategory(key, settingsMap.get(key), this.log),
      ]),
    ) as AppSettings;
  }

  async set<K extends SettingsCategory>(key: K, value: AppSettings[K]): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value: value as unknown })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: value as unknown },
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
