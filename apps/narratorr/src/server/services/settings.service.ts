import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { settings } from '@narratorr/db/schema';
import type { AppSettings } from '../../shared/schemas.js';

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

export class SettingsService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  async get<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
    const result = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);

    if (result.length === 0) {
      return DEFAULT_SETTINGS[key];
    }

    return result[0].value as AppSettings[K];
  }

  async getAll(): Promise<AppSettings> {
    const results = await this.db.select().from(settings);

    const settingsMap = new Map(results.map((r) => [r.key, r.value]));

    return {
      library: (settingsMap.get('library') as AppSettings['library']) || DEFAULT_SETTINGS.library,
      search: (settingsMap.get('search') as AppSettings['search']) || DEFAULT_SETTINGS.search,
      import: (settingsMap.get('import') as AppSettings['import']) || DEFAULT_SETTINGS.import,
      general: (settingsMap.get('general') as AppSettings['general']) || DEFAULT_SETTINGS.general,
      metadata: (settingsMap.get('metadata') as AppSettings['metadata']) || DEFAULT_SETTINGS.metadata,
      processing: (settingsMap.get('processing') as AppSettings['processing']) || DEFAULT_SETTINGS.processing,
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
