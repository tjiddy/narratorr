import { eq } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import { settings } from '@narratorr/db/schema';

export interface AppSettings {
  library: {
    path: string;
    folderFormat: string;
  };
  search: {
    intervalMinutes: number;
    enabled: boolean;
  };
  import: {
    deleteAfterImport: boolean;
    minSeedTime: number;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  library: {
    path: '/audiobooks',
    folderFormat: '{author}/{title}',
  },
  search: {
    intervalMinutes: 360,
    enabled: true,
  },
  import: {
    deleteAfterImport: false,
    minSeedTime: 60,
  },
};

export class SettingsService {
  constructor(private db: Db) {}

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
