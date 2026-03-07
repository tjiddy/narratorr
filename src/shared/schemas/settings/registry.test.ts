import { describe, it, expect } from 'vitest';
import {
  settingsRegistry,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
  appSettingsSchema,
  updateSettingsSchema,
  updateSettingsFormSchema,
  settingsToFormData,
  type AppSettings,
} from './registry.js';

describe('settingsRegistry', () => {
  describe('invariants', () => {
    it('every category entry has a schema property that is a Zod schema', () => {
      for (const key of SETTINGS_CATEGORIES) {
        const entry = settingsRegistry[key];
        expect(entry.schema).toBeDefined();
        expect(typeof entry.schema.safeParse).toBe('function');
      }
    });

    it('every category entry has a defaults property that is not undefined/null', () => {
      for (const key of SETTINGS_CATEGORIES) {
        expect(settingsRegistry[key].defaults).toBeDefined();
        expect(settingsRegistry[key].defaults).not.toBeNull();
      }
    });

    it('schema.safeParse(defaults) succeeds for every category', () => {
      for (const key of SETTINGS_CATEGORIES) {
        const { schema, defaults } = settingsRegistry[key];
        const result = schema.safeParse(defaults);
        expect(result.success, `${key}: ${JSON.stringify(result.success ? null : result.error.issues)}`).toBe(true);
      }
    });

    it('exports exactly the expected category keys', () => {
      const expected = ['library', 'search', 'import', 'general', 'metadata', 'processing', 'tagging', 'quality'];
      expect(SETTINGS_CATEGORIES.sort()).toEqual(expected.sort());
    });

    it('SETTINGS_CATEGORIES matches registry keys', () => {
      expect(SETTINGS_CATEGORIES.sort()).toEqual(Object.keys(settingsRegistry).sort());
    });
  });

  describe('schema-default mismatch preservation', () => {
    it('library defaults have correct values', () => {
      expect(DEFAULT_SETTINGS.library).toEqual({
        path: '/audiobooks',
        folderFormat: '{author}/{title}',
        fileFormat: '{author} - {title}',
      });
    });

    it('search defaults have intervalMinutes 360 (not schema default 60) and enabled true (not schema default false)', () => {
      expect(DEFAULT_SETTINGS.search).toEqual({ intervalMinutes: 360, enabled: true });
      // Verify schema default differs from runtime default
      const schemaParsed = settingsRegistry.search.schema.parse({});
      expect(schemaParsed.intervalMinutes).toBe(60); // schema default
      expect(DEFAULT_SETTINGS.search.intervalMinutes).toBe(360); // runtime default
      expect(schemaParsed.enabled).toBe(false); // schema default
      expect(DEFAULT_SETTINGS.search.enabled).toBe(true); // runtime default
    });

    it('import defaults have deleteAfterImport false and minSeedTime 60 (not schema default 0)', () => {
      expect(DEFAULT_SETTINGS.import).toEqual({ deleteAfterImport: false, minSeedTime: 60 });
      const schemaParsed = settingsRegistry.import.schema.parse({});
      expect(schemaParsed.minSeedTime).toBe(0); // schema default
      expect(DEFAULT_SETTINGS.import.minSeedTime).toBe(60); // runtime default
    });

    it('general defaults have logLevel info', () => {
      expect(DEFAULT_SETTINGS.general).toEqual({ logLevel: 'info' });
    });

    it('metadata defaults have audibleRegion us', () => {
      expect(DEFAULT_SETTINGS.metadata).toEqual({ audibleRegion: 'us' });
    });

    it('processing defaults have all expected values', () => {
      expect(DEFAULT_SETTINGS.processing).toEqual({
        enabled: false,
        ffmpegPath: '',
        outputFormat: 'm4b',
        keepOriginalBitrate: false,
        bitrate: 128,
        mergeBehavior: 'multi-file-only',
      });
    });

    it('tagging defaults have all expected values', () => {
      expect(DEFAULT_SETTINGS.tagging).toEqual({
        enabled: false,
        mode: 'populate_missing',
        embedCover: false,
      });
    });

    it('quality defaults have all expected values', () => {
      expect(DEFAULT_SETTINGS.quality).toEqual({
        grabFloor: 0,
        protocolPreference: 'none',
        minSeeders: 0,
        searchImmediately: false,
        monitorForUpgrades: false,
      });
    });
  });

  describe('derived constants', () => {
    it('DEFAULT_SETTINGS derived from registry matches all category defaults', () => {
      for (const key of SETTINGS_CATEGORIES) {
        expect(DEFAULT_SETTINGS[key]).toEqual(settingsRegistry[key].defaults);
      }
    });

    it('CATEGORY_SCHEMAS derived from registry has schema for every category', () => {
      for (const key of SETTINGS_CATEGORIES) {
        expect(CATEGORY_SCHEMAS[key]).toBe(settingsRegistry[key].schema);
      }
    });
  });

  describe('composed schemas', () => {
    it('appSettingsSchema validates complete settings', () => {
      const result = appSettingsSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
    });

    it('updateSettingsSchema accepts empty update', () => {
      const result = updateSettingsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('updateSettingsSchema accepts partial category update', () => {
      const result = updateSettingsSchema.safeParse({ search: { enabled: false } });
      expect(result.success).toBe(true);
    });

    it('updateSettingsSchema rejects processing enabled with empty ffmpegPath', () => {
      const result = updateSettingsSchema.safeParse({
        processing: { enabled: true, ffmpegPath: '' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('form schema derivation', () => {
    it('form schema validates complete form data', () => {
      const result = updateSettingsFormSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
    });

    it('derived form schema rejects empty library.path', () => {
      const data = { ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, path: '' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('form schema processing superRefine: enabled true with empty ffmpegPath produces error', () => {
      const data = { ...DEFAULT_SETTINGS, processing: { ...DEFAULT_SETTINGS.processing, enabled: true, ffmpegPath: '' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('form schema processing superRefine: enabled false with empty ffmpegPath passes', () => {
      const data = { ...DEFAULT_SETTINGS, processing: { ...DEFAULT_SETTINGS.processing, enabled: false, ffmpegPath: '' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('form schema folder format validation: valid template passes', () => {
      const data = { ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, folderFormat: '{author}/{title}' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('form schema folder format validation: unknown token produces error', () => {
      const data = { ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, folderFormat: '{badToken}/{title}' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('form schema file format validation: valid template passes', () => {
      const data = { ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, fileFormat: '{author} - {title}' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('form schema file format validation: unknown token produces error', () => {
      const data = { ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, fileFormat: '{title} - {bogus}' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('category with formSchema override uses override for form validation', () => {
      // Library has a formSchema override — verify it has min(1) on folderFormat
      const data = { ...DEFAULT_SETTINGS, library: { ...DEFAULT_SETTINGS.library, folderFormat: '' } };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('category without formSchema override uses mechanically derived schema', () => {
      // Search has no formSchema override — verify defaults are stripped (empty object fails)
      const data = { ...DEFAULT_SETTINGS, search: {} as never };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('falsy defaults preserved: processing.enabled false', () => {
      expect(DEFAULT_SETTINGS.processing.enabled).toBe(false);
      const result = appSettingsSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as AppSettings).processing.enabled).toBe(false);
      }
    });

    it('zero defaults preserved: quality.grabFloor 0', () => {
      expect(DEFAULT_SETTINGS.quality.grabFloor).toBe(0);
      const result = appSettingsSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as AppSettings).quality.grabFloor).toBe(0);
      }
    });

    it('empty string defaults preserved: processing.ffmpegPath empty string', () => {
      expect(DEFAULT_SETTINGS.processing.ffmpegPath).toBe('');
      const result = appSettingsSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as AppSettings).processing.ffmpegPath).toBe('');
      }
    });

    it('category where Zod defaults match runtime defaults: quality', () => {
      const schemaParsed = settingsRegistry.quality.schema.parse({});
      expect(schemaParsed).toEqual(DEFAULT_SETTINGS.quality);
    });

    it('category where Zod defaults differ from runtime defaults: search', () => {
      const schemaParsed = settingsRegistry.search.schema.parse({});
      expect(schemaParsed).not.toEqual(DEFAULT_SETTINGS.search);
    });
  });

  describe('stripDefaults behavior (via form schema)', () => {
    it('form schema rejects missing fields that have .default() in base schema', () => {
      // search.intervalMinutes has .default(60) in the base schema, so parse({}) works.
      // But the form schema strips defaults, so omitting it should fail.
      const data = { ...DEFAULT_SETTINGS, search: {} as never };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('form schema requires fields even when base schema provides defaults', () => {
      // processing has multiple .default() fields. Form schema should require all of them.
      const data = { ...DEFAULT_SETTINGS, processing: { enabled: true } as never };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it('form schema accepts fields when all values are explicitly provided', () => {
      // Proving that stripDefaults didn't break the schema — full values still pass
      const result = updateSettingsFormSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
    });
  });

  describe('settingsToFormData', () => {
    it('converts full settings to form data', () => {
      const result = settingsToFormData(DEFAULT_SETTINGS);
      expect(result).toEqual(DEFAULT_SETTINGS);
    });

    it('spreads defaults under stored values', () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        search: { intervalMinutes: 120, enabled: false },
      };
      const result = settingsToFormData(settings);
      expect(result.search).toEqual({ intervalMinutes: 120, enabled: false });
    });

    it('falls back to defaults for missing category properties', () => {
      // Simulate a partial settings object where a category has undefined fields
      const settings = {
        ...DEFAULT_SETTINGS,
        search: {} as AppSettings['search'],
      };
      const result = settingsToFormData(settings);
      // Spread of empty object over defaults = defaults win
      expect(result.search).toEqual(DEFAULT_SETTINGS.search);
    });
  });
});
