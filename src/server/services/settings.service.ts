import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { settings } from '../../db/schema.js';
import {
  type AppSettings,
  type SettingsCategory,
  type UpdateSettingsInput,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
} from '../../shared/schemas.js';
import { normalizeLanguage } from '../../core/utils/language-codes.js';
import { CANONICAL_LANGUAGES } from '../../shared/language-constants.js';
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

  async patch<K extends SettingsCategory>(category: K, partial: Partial<AppSettings[K]>): Promise<AppSettings[K]> {
    const existing = await this.get(category);
    if (Object.keys(partial).length === 0) return existing;
    const merged = { ...existing, ...partial } as AppSettings[K];
    await this.set(category, merged);
    return merged;
  }

  async update(partial: UpdateSettingsInput): Promise<AppSettings> {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        const category = key as SettingsCategory;
        await this.patch(category, value as Partial<AppSettings[typeof category]>);
      }
    }
    return this.getAll();
  }

  /**
   * Run once at startup: if no processing row exists and ffmpeg can be found,
   * pre-fill ffmpegPath with the detected path but leave processing.enabled=false
   * so the user must explicitly opt in before audio files are modified.
   */
  async bootstrapProcessingDefaults(detectFfmpegPath: () => Promise<string | null>): Promise<void> {
    const existing = await this.db.select().from(settings).where(eq(settings.key, 'processing')).limit(1);
    if (existing.length > 0) return;

    const ffmpegPath = await detectFfmpegPath();
    if (!ffmpegPath) return;

    await this.set('processing', { ...DEFAULT_SETTINGS.processing, enabled: false, ffmpegPath });
  }

  /**
   * Run once at startup: migrate quality.preferredLanguage to metadata.languages.
   * Idempotent — skips if metadata.languages already exists in the raw blob.
   */
  async migrateLanguageSettings(): Promise<void> {
    try {
      // Check if metadata already has languages (idempotency)
      const metadataRow = await this.db.select().from(settings).where(eq(settings.key, 'metadata')).limit(1);
      const metadataBlob = (metadataRow[0]?.value ?? {}) as Record<string, unknown>;
      if (Array.isArray(metadataBlob.languages)) return;

      // Read raw quality blob (bypasses Zod to access legacy field)
      const qualityRow = await this.db.select().from(settings).where(eq(settings.key, 'quality')).limit(1);
      if (qualityRow.length === 0) return;

      const qualityBlob = { ...(qualityRow[0].value as Record<string, unknown>) };
      const preferredLanguage = qualityBlob.preferredLanguage;

      // Migrate non-empty preferredLanguage to metadata.languages
      if (typeof preferredLanguage === 'string' && preferredLanguage.trim()) {
        const normalized = normalizeLanguage(preferredLanguage);
        const canonicalSet = new Set<string>(CANONICAL_LANGUAGES);
        if (normalized && canonicalSet.has(normalized)) {
          await this.patch('metadata', { languages: [normalized] } as Partial<AppSettings['metadata']>);
          this.log.info({ from: preferredLanguage, to: normalized }, 'Migrated preferredLanguage to metadata.languages');
        } else {
          this.log.warn({ preferredLanguage }, 'Legacy preferredLanguage is not a canonical language — skipping migration, defaults will apply');
        }
      }

      // Clean up: remove preferredLanguage from raw quality blob
      delete qualityBlob.preferredLanguage;
      await this.db
        .insert(settings)
        .values({ key: 'quality', value: qualityBlob })
        .onConflictDoUpdate({ target: settings.key, set: { value: qualityBlob } });
    } catch (error: unknown) {
      this.log.warn({ error }, 'Language settings migration failed — fresh defaults will apply');
    }
  }
}
