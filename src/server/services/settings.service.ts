import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { settings, settingsMigrations } from '@db/schema.js';
import {
  type AppSettings,
  type SettingsCategory,
  type UpdateSettingsInput,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
} from '@shared/schemas.js';
import { DEFAULT_REJECT_WORDS } from '@shared/schemas/settings/quality.js';
import { normalizeLanguage } from '@core/utils/language-codes.js';
import { CANONICAL_LANGUAGES } from '@shared/language-constants.js';
import { decryptFields, getKey } from '../utils/secret-codec.js';
import { resolveAndEncryptSettings } from '../utils/sentinel-resolver.js';
import { SECRET_CATEGORIES } from '../utils/secret-category-map.js';
import { serializeError } from '../utils/serialize-error.js';
import { withLibraryRootWrite } from './library-root-gate.js';


export type { AppSettings };

/**
 * Callers own what get()/getAll() hand back. Returning the shared DEFAULT_SETTINGS entry would let
 * one caller's mutation corrupt the packaged defaults process-wide, for every later miss in every
 * service. Deep, not a spread: metadata.languages is an array and a shallow copy still shares it.
 */
function defaultsFor<K extends SettingsCategory>(key: K): AppSettings[K] {
  return structuredClone(DEFAULT_SETTINGS[key]);
}

function parseCategory<K extends SettingsCategory>(
  key: K,
  raw: unknown,
  log: FastifyBaseLogger,
): AppSettings[K] {
  if (raw === undefined || raw === null) {
    return defaultsFor(key);
  }
  const schema = CATEGORY_SCHEMAS[key];
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data as AppSettings[K];
  }
  log.warn({ category: key, errors: result.error.issues }, 'Settings parse failed, using defaults');
  return defaultsFor(key);
}

// Covers page-load and navigation jitter without hiding settings flips for long.
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class SettingsService {
  private categoryCache = new Map<string, CacheEntry>();
  private allCache: CacheEntry | null = null;

  constructor(private db: Db, private log: FastifyBaseLogger) {}

  private invalidateCache(key?: string): void {
    if (key) {
      this.categoryCache.delete(key);
    }
    this.allCache = null;
  }

  async get<K extends SettingsCategory>(key: K): Promise<AppSettings[K]> {
    const cached = this.categoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as AppSettings[K];
    }

    const result = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);

    // Never cache a missing row: a row inserted by another connection (restore-from-backup, a
    // migration backfill, an external write) has no invalidation path, so a cached default would
    // hide it for the full TTL. Gate on the DB result, not on whether an entry already exists —
    // an expired entry lingers here (the hit check above compares expiresAt without deleting).
    if (result.length === 0) {
      return defaultsFor(key);
    }

    let raw = result[0]!.value;
    const entity = SECRET_CATEGORIES[key];
    if (entity && raw && typeof raw === 'object') {
      raw = decryptFields(entity, { ...(raw as Record<string, unknown>) }, getKey(), this.log);
    }

    const parsed = parseCategory(key, raw, this.log);
    this.categoryCache.set(key, { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
    return parsed;
  }

  async getAll(): Promise<AppSettings> {
    if (this.allCache && this.allCache.expiresAt > Date.now()) {
      return this.allCache.value as AppSettings;
    }

    const results = await this.db.select().from(settings);

    const settingsMap = new Map(results.map((r) => [r.key, r.value]));
    // `has`, not a nullish check on the value: a stored JSON null is a present row and stays
    // cacheable, matching get()'s row-presence rule.
    const complete = SETTINGS_CATEGORIES.every((key) => settingsMap.has(key));

    const all = Object.fromEntries(
      SETTINGS_CATEGORIES.map((key) => {
        let raw = settingsMap.get(key);
        const entity = SECRET_CATEGORIES[key];
        if (entity && raw && typeof raw === 'object') {
          raw = decryptFields(entity, { ...(raw as Record<string, unknown>) }, getKey(), this.log);
        }
        return [key, parseCategory(key, raw, this.log)];
      }),
    ) as AppSettings;

    // A partial composition carries the same uncacheable defaults get()'s miss arm refuses to pin.
    if (complete) {
      this.allCache = { value: all, expiresAt: Date.now() + CACHE_TTL_MS };
    }
    return all;
  }

  async set<K extends SettingsCategory>(key: K, value: AppSettings[K]): Promise<void> {
    let dbValue: unknown = value;
    // Resolve masked sentinels before encrypting secret categories.
    const entity = SECRET_CATEGORIES[key];
    if (entity && dbValue && typeof dbValue === 'object') {
      const existing = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
      dbValue = resolveAndEncryptSettings(entity, dbValue as Record<string, unknown>, existing[0]?.value as Record<string, unknown> | undefined);
    }

    await this.db
      .insert(settings)
      .values({ key, value: dbValue })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: dbValue },
      });
    this.invalidateCache(key);
    this.log.info({ category: key }, 'Settings updated');
  }

  async patch<K extends SettingsCategory>(category: K, partial: Partial<AppSettings[K]>): Promise<AppSettings[K]> {
    const existing = await this.get(category);
    if (Object.keys(partial).length === 0) return existing;
    const merged = { ...existing, ...partial } as AppSettings[K];
    await this.set(category, merged);
    return merged;
  }

  /**
   * A request touching `library` goes through the root-scope gate, which refuses while an import,
   * merge or rename is deriving paths from the current root. The gate wraps the WHOLE loop, not the
   * `library` iteration, because the loop is nontransactional: a refusal decided mid-loop would
   * leave earlier categories written. Scoped to the category rather than to `path` alone because
   * `folderFormat`/`fileFormat` are part of the same controlling snapshot a commit derives from.
   */
  async update(partial: UpdateSettingsInput): Promise<AppSettings> {
    if (partial.library !== undefined) {
      return withLibraryRootWrite(() => this.applyUpdate(partial));
    }
    return this.applyUpdate(partial);
  }

  private async applyUpdate(partial: UpdateSettingsInput): Promise<AppSettings> {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        const category = key as SettingsCategory;
        await this.patch(category, value as Partial<AppSettings[typeof category]>);
      }
    }
    return this.getAll();
  }

  /** Read removed ffmpegPath from raw storage so boot can warn operators to use FFMPEG_PATH. */
  async getLegacyFfmpegPath(): Promise<string | undefined> {
    const row = await this.db.select().from(settings).where(eq(settings.key, 'processing')).limit(1);
    const raw = row[0]?.value as Record<string, unknown> | undefined;
    const val = raw?.ffmpegPath;
    return typeof val === 'string' && val.trim() ? val.trim() : undefined;
  }

  /** Migrate raw quality.preferredLanguage unless raw metadata.languages already exists. */
  async migrateLanguageSettings(): Promise<void> {
    try {
      const metadataRow = await this.db.select().from(settings).where(eq(settings.key, 'metadata')).limit(1);
      const metadataBlob = (metadataRow[0]?.value ?? {}) as Record<string, unknown>;
      if (Array.isArray(metadataBlob.languages)) return;

      const qualityRow = await this.db.select().from(settings).where(eq(settings.key, 'quality')).limit(1);
      if (qualityRow.length === 0) return;

      const qualityBlob = { ...(qualityRow[0]!.value as Record<string, unknown>) };
      const preferredLanguage = qualityBlob.preferredLanguage;

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

      delete qualityBlob.preferredLanguage;
      await this.db
        .insert(settings)
        .values({ key: 'quality', value: qualityBlob })
        .onConflictDoUpdate({ target: settings.key, set: { value: qualityBlob } });
      this.invalidateCache('quality');
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Language settings migration failed — fresh defaults will apply');
    }
  }

  /** Replace the legacy empty default once; later intentional empty values must stay empty. */
  async migrateRejectWordsDefault(): Promise<void> {
    const MIGRATION_ID = 'rejectWords-defaults-v1';
    try {
      const flagRow = await this.db
        .select()
        .from(settingsMigrations)
        .where(eq(settingsMigrations.id, MIGRATION_ID))
        .limit(1);
      if (flagRow.length > 0) return;

      const qualityRow = await this.db.select().from(settings).where(eq(settings.key, 'quality')).limit(1);
      if (qualityRow.length > 0) {
        const stored = { ...(qualityRow[0]!.value as Record<string, unknown>) };
        if (stored.rejectWords === '') {
          stored.rejectWords = DEFAULT_REJECT_WORDS;
          await this.db
            .insert(settings)
            .values({ key: 'quality', value: stored })
            .onConflictDoUpdate({ target: settings.key, set: { value: stored } });
          this.invalidateCache('quality');
          this.log.info({ migration: MIGRATION_ID }, 'Migrated legacy empty rejectWords to packaged defaults');
        }
      }

      await this.db
        .insert(settingsMigrations)
        .values({ id: MIGRATION_ID })
        .onConflictDoNothing();
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error), migration: MIGRATION_ID }, 'rejectWords defaults migration failed — will retry on next boot');
    }
  }

  /**
   * Upgrade only the exact hardcoded v1 default; preserve custom and empty values, then always
   * record v2. Future packaged-default changes need their own hardcoded migration.
   */
  async migrateRejectWordsAbridgedDefault(): Promise<void> {
    const MIGRATION_ID = 'rejectWords-defaults-v2-abridged';
    const OLD_DEFAULT = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes';
    const NEW_DEFAULT = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged';
    try {
      const flagRow = await this.db
        .select()
        .from(settingsMigrations)
        .where(eq(settingsMigrations.id, MIGRATION_ID))
        .limit(1);
      if (flagRow.length > 0) return;

      const qualityRow = await this.db.select().from(settings).where(eq(settings.key, 'quality')).limit(1);
      if (qualityRow.length > 0) {
        const stored = { ...(qualityRow[0]!.value as Record<string, unknown>) };
        if (stored.rejectWords === OLD_DEFAULT) {
          stored.rejectWords = NEW_DEFAULT;
          await this.db
            .insert(settings)
            .values({ key: 'quality', value: stored })
            .onConflictDoUpdate({ target: settings.key, set: { value: stored } });
          this.invalidateCache('quality');
          this.log.info({ migration: MIGRATION_ID }, 'Appended Abridged to legacy packaged rejectWords default');
        }
      }

      await this.db
        .insert(settingsMigrations)
        .values({ id: MIGRATION_ID })
        .onConflictDoNothing();
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error), migration: MIGRATION_ID }, 'rejectWords abridged migration failed — will retry on next boot');
    }
  }

  /**
   * Rewrite frozen default 2→1 but preserve intentional 3–8. Read raw storage so values above 8
   * can be clamped without parseCategory replacing the whole blob; always mark the migration done.
   */
  async migrateMaxConcurrentProcessingDefaults(): Promise<void> {
    const MIGRATION_ID = 'maxConcurrentProcessing-defaults-v1';
    try {
      const flagRow = await this.db
        .select()
        .from(settingsMigrations)
        .where(eq(settingsMigrations.id, MIGRATION_ID))
        .limit(1);
      if (flagRow.length > 0) return;

      const processingRow = await this.db.select().from(settings).where(eq(settings.key, 'processing')).limit(1);
      if (processingRow.length > 0) {
        const stored = { ...(processingRow[0]!.value as Record<string, unknown>) };
        const value = stored.maxConcurrentProcessing;
        let rewrite: number | null = null;
        if (value === 2) {
          rewrite = 1;
        } else if (typeof value === 'number' && value > 8) {
          rewrite = 8;
        }
        if (rewrite !== null) {
          stored.maxConcurrentProcessing = rewrite;
          await this.db
            .insert(settings)
            .values({ key: 'processing', value: stored })
            .onConflictDoUpdate({ target: settings.key, set: { value: stored } });
          this.invalidateCache('processing');
          this.log.info({ migration: MIGRATION_ID, from: value, to: rewrite }, 'Migrated stored maxConcurrentProcessing');
        }
      }

      await this.db
        .insert(settingsMigrations)
        .values({ id: MIGRATION_ID })
        .onConflictDoNothing();
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error), migration: MIGRATION_ID }, 'maxConcurrentProcessing defaults migration failed — will retry on next boot');
    }
  }
}
