import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { settings } from '@narratorr/db/schema';
import {
  type AppSettings,
  librarySettingsSchema,
  searchSettingsSchema,
  importSettingsSchema,
  generalSettingsSchema,
  metadataSettingsSchema,
  processingSettingsSchema,
} from '../../shared/schemas.js';

export type { AppSettings };

const DEFAULT_SETTINGS: AppSettings = {
  library: {
    path: '/audiobooks',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
  },
  search: {
    intervalMinutes: 360,
    enabled: true,
  },
  import: {
    deleteAfterImport: false,
    minSeedTime: 60,
  },
  general: {
    logLevel: 'info',
  },
  metadata: {
    audibleRegion: 'us',
  },
  processing: {
    enabled: false,
    ffmpegPath: '',
    outputFormat: 'm4b',
    keepOriginalBitrate: false,
    bitrate: 128,
    mergeBehavior: 'multi-file-only',
  },
};

const CATEGORY_SCHEMAS = {
  library: librarySettingsSchema,
  search: searchSettingsSchema,
  import: importSettingsSchema,
  general: generalSettingsSchema,
  metadata: metadataSettingsSchema,
  processing: processingSettingsSchema,
} as const;

/**
 * Parse a raw DB JSON value through its category schema.
 * Falls back to the default on parse failure (fail-soft for existing data).
 */
function parseCategory<K extends keyof AppSettings>(
  key: K,
  raw: unknown,
  log: FastifyBaseLogger,
): AppSettings[K] {
  // undefined/null = not stored yet, just use defaults silently
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

  async get<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
    const result = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);

    if (result.length === 0) {
      return DEFAULT_SETTINGS[key];
    }

    return parseCategory(key, result[0].value, this.log);
  }

  async getAll(): Promise<AppSettings> {
    const results = await this.db.select().from(settings);

    const settingsMap = new Map(results.map((r) => [r.key, r.value]));

    return {
      library: parseCategory('library', settingsMap.get('library'), this.log) ?? DEFAULT_SETTINGS.library,
      search: parseCategory('search', settingsMap.get('search'), this.log) ?? DEFAULT_SETTINGS.search,
      import: parseCategory('import', settingsMap.get('import'), this.log) ?? DEFAULT_SETTINGS.import,
      general: parseCategory('general', settingsMap.get('general'), this.log) ?? DEFAULT_SETTINGS.general,
      metadata: parseCategory('metadata', settingsMap.get('metadata'), this.log) ?? DEFAULT_SETTINGS.metadata,
      processing: parseCategory('processing', settingsMap.get('processing'), this.log) ?? DEFAULT_SETTINGS.processing,
    };
  }

  async set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
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
        await this.set(key as keyof AppSettings, value);
      }
    }
    return this.getAll();
  }
}
