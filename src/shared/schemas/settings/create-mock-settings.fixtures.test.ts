import { describe, it, expect } from 'vitest';
import { createMockSettings } from './create-mock-settings.fixtures.js';
import { DEFAULT_SETTINGS, CATEGORY_SCHEMAS, SETTINGS_CATEGORIES } from './registry.js';

describe('createMockSettings', () => {
  describe('factory core behavior', () => {
    it('returns a complete AppSettings object that passes Zod schema validation for every category', () => {
      const settings = createMockSettings();
      for (const category of SETTINGS_CATEGORIES) {
        expect(() => CATEGORY_SCHEMAS[category].parse(settings[category])).not.toThrow();
      }
    });

    it('no-arg call returns all 11 categories with all fields populated from DEFAULT_SETTINGS', () => {
      const settings = createMockSettings();
      expect(Object.keys(settings).sort()).toEqual(SETTINGS_CATEGORIES.slice().sort());
      for (const category of SETTINGS_CATEGORIES) {
        expect(settings[category]).toEqual(DEFAULT_SETTINGS[category]);
      }
    });

    it('single-field override preserves all sibling defaults in the same category', () => {
      const settings = createMockSettings({ processing: { ffmpegPath: '/usr/bin/ffmpeg' } });
      expect(settings.processing.ffmpegPath).toBe('/usr/bin/ffmpeg');
      // All other processing fields should remain at defaults
      expect(settings.processing.outputFormat).toBe(DEFAULT_SETTINGS.processing.outputFormat);
      expect(settings.processing.bitrate).toBe(DEFAULT_SETTINGS.processing.bitrate);
      expect(settings.processing.keepOriginalBitrate).toBe(DEFAULT_SETTINGS.processing.keepOriginalBitrate);
      expect(settings.processing.mergeBehavior).toBe(DEFAULT_SETTINGS.processing.mergeBehavior);
      expect(settings.processing.maxConcurrentProcessing).toBe(DEFAULT_SETTINGS.processing.maxConcurrentProcessing);
      expect(settings.processing.postProcessingScript).toBe(DEFAULT_SETTINGS.processing.postProcessingScript);
      expect(settings.processing.postProcessingScriptTimeout).toBe(DEFAULT_SETTINGS.processing.postProcessingScriptTimeout);
    });

    it('multi-category override preserves unmentioned categories', () => {
      const settings = createMockSettings({
        search: { enabled: false },
        quality: { minSeeders: 5 },
      });
      expect(settings.search.enabled).toBe(false);
      expect(settings.search.intervalMinutes).toBe(DEFAULT_SETTINGS.search.intervalMinutes);
      expect(settings.quality.minSeeders).toBe(5);
      expect(settings.quality.grabFloor).toBe(DEFAULT_SETTINGS.quality.grabFloor);
      // Unmentioned categories untouched
      expect(settings.library).toEqual(DEFAULT_SETTINGS.library);
      expect(settings.general).toEqual(DEFAULT_SETTINGS.general);
      expect(settings.processing).toEqual(DEFAULT_SETTINGS.processing);
    });
  });

  describe('boundary / edge cases', () => {
    it('override with undefined value does not strip the default', () => {
      const settings = createMockSettings({ processing: { ffmpegPath: undefined } } as unknown as Parameters<typeof createMockSettings>[0]);
      expect(settings.processing.ffmpegPath).toBe(DEFAULT_SETTINGS.processing.ffmpegPath);
    });

    it('preserves falsy-but-valid values: minFreeSpaceGB: 0', () => {
      const settings = createMockSettings({ import: { minFreeSpaceGB: 0 } });
      expect(settings.import.minFreeSpaceGB).toBe(0);
    });

    it('preserves falsy-but-valid values: empty string proxyUrl', () => {
      const settings = createMockSettings({ network: { proxyUrl: '' } });
      expect(settings.network.proxyUrl).toBe('');
    });

    it('override with empty object for a category returns full defaults', () => {
      const settings = createMockSettings({ processing: {} });
      expect(settings.processing).toEqual(DEFAULT_SETTINGS.processing);
    });

    it('override with all fields for a category returns exact override values', () => {
      const customProcessing = {
        ffmpegPath: '/custom/ffmpeg',
        outputFormat: 'mp3' as const,
        keepOriginalBitrate: true,
        bitrate: 64,
        mergeBehavior: 'always' as const,
        maxConcurrentProcessing: 4,
        postProcessingScript: '/run.sh',
        postProcessingScriptTimeout: 600,
      };
      const settings = createMockSettings({ processing: customProcessing });
      expect(settings.processing).toEqual(customProcessing);
    });
  });

  describe('schema validation consistency', () => {
    it('factory output satisfies all category Zod schemas', () => {
      const settings = createMockSettings({
        processing: { ffmpegPath: '/usr/bin/ffmpeg' },
      });
      for (const category of SETTINGS_CATEGORIES) {
        expect(() => CATEGORY_SCHEMAS[category].parse(settings[category])).not.toThrow();
      }
    });

    it('factory defaults have an empty ffmpegPath', () => {
      const settings = createMockSettings();
      expect(settings.processing.ffmpegPath).toBe('');
    });
  });

  describe('type safety', () => {
    it('DeepPartial allows partial overrides at every nesting level', () => {
      // This test validates compile-time type safety by exercising the override API
      const settings = createMockSettings({
        general: { logLevel: 'debug' },
        library: { path: '/custom' },
        search: { intervalMinutes: 60 },
        import: { deleteAfterImport: true },
        metadata: { audibleRegion: 'uk' },
        processing: { bitrate: 64 },
        tagging: { enabled: true },
        quality: { grabFloor: 100 },
        network: { proxyUrl: 'socks5://proxy:1080' },
        rss: { enabled: true },
        system: { backupRetention: 3 },
      });
      expect(settings.general.logLevel).toBe('debug');
      expect(settings.library.path).toBe('/custom');
      expect(settings.system.backupRetention).toBe(3);
      // Non-overridden fields keep defaults
      expect(settings.general.housekeepingRetentionDays).toBe(DEFAULT_SETTINGS.general.housekeepingRetentionDays);
    });
  });

  describe('returns a fresh copy', () => {
    it('does not mutate DEFAULT_SETTINGS when overrides are provided', () => {
      const before = JSON.stringify(DEFAULT_SETTINGS);
      const settings = createMockSettings({ processing: { ffmpegPath: '/usr/bin/ffmpeg' } });
      settings.processing.bitrate = 999;
      expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
    });

    it('does not mutate DEFAULT_SETTINGS when no overrides are provided', () => {
      const before = JSON.stringify(DEFAULT_SETTINGS);
      const settings = createMockSettings();
      settings.processing.ffmpegPath = '/usr/bin/ffmpeg';
      settings.processing.bitrate = 999;
      expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
    });

    it('returns independent copies on successive calls', () => {
      const a = createMockSettings();
      const b = createMockSettings();
      a.processing.ffmpegPath = '/custom';
      expect(b.processing.ffmpegPath).toBe('');
    });
  });
});
