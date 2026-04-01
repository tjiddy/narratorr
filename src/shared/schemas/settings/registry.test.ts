import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  settingsRegistry,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS,
  CATEGORY_SCHEMAS,
  appSettingsSchema,
  updateSettingsSchema,
  updateSettingsFormSchema,
  settingsToFormData,
  stripDefaults,
  type AppSettings,
} from './registry.js';
import { importSettingsSchema } from './import.js';
import { processingSettingsSchema } from './processing.js';
import { generalFormSchema } from './general.js';
import { discoveryFormSchema } from './discovery.js';
import { qualityFormSchema } from './quality.js';

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
      const expected = ['library', 'search', 'import', 'general', 'metadata', 'processing', 'tagging', 'quality', 'network', 'rss', 'system', 'discovery'];
      expect(SETTINGS_CATEGORIES.sort()).toEqual(expected.sort());
    });

    it('SETTINGS_CATEGORIES matches registry keys', () => {
      expect(SETTINGS_CATEGORIES.sort()).toEqual(Object.keys(settingsRegistry).sort());
    });
  });

  describe('schema-default alignment', () => {
    it('library defaults have correct values', () => {
      expect(DEFAULT_SETTINGS.library).toEqual({
        path: '/audiobooks',
        folderFormat: '{author}/{title}',
        fileFormat: '{author} - {title}',
        namingSeparator: 'space',
        namingCase: 'default',
      });
    });

    it('search schema defaults match registry defaults', () => {
      expect(DEFAULT_SETTINGS.search).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 });
      const schemaParsed = settingsRegistry.search.schema.parse({});
      expect(schemaParsed.intervalMinutes).toBe(360);
      expect(schemaParsed.enabled).toBe(true);
      expect(schemaParsed.blacklistTtlDays).toBe(7);
      expect(schemaParsed).toEqual(DEFAULT_SETTINGS.search);
    });

    it('import schema defaults match registry defaults', () => {
      expect(DEFAULT_SETTINGS.import).toEqual({ deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5, redownloadFailed: true });
      const schemaParsed = settingsRegistry.import.schema.parse({});
      expect(schemaParsed.minSeedTime).toBe(60);
      expect(schemaParsed.minFreeSpaceGB).toBe(5);
      expect(schemaParsed.redownloadFailed).toBe(true);
      expect(schemaParsed).toEqual(DEFAULT_SETTINGS.import);
    });

    it('importSettingsSchema accepts redownloadFailed: true and false', () => {
      expect(settingsRegistry.import.schema.parse({ redownloadFailed: true }).redownloadFailed).toBe(true);
      expect(settingsRegistry.import.schema.parse({ redownloadFailed: false }).redownloadFailed).toBe(false);
    });

    it('importSettingsSchema defaults redownloadFailed to true when omitted', () => {
      const parsed = settingsRegistry.import.schema.parse({});
      expect(parsed.redownloadFailed).toBe(true);
    });

    it('general defaults have logLevel info, housekeepingRetentionDays 90, and welcomeSeen false', () => {
      expect(DEFAULT_SETTINGS.general).toEqual({ logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: false });
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
        maxConcurrentProcessing: 2,
        postProcessingScript: '',
        postProcessingScriptTimeout: 300,
      });
    });

    it('postProcessingScriptTimeout defaults to 300 when omitted', () => {
      const result = processingSettingsSchema.parse({});
      expect(result.postProcessingScriptTimeout).toBe(300);
    });

    it('postProcessingScriptTimeout rejects zero', () => {
      const result = processingSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS.processing,
        postProcessingScriptTimeout: 0,
      });
      expect(result.success).toBe(false);
    });

    it('postProcessingScriptTimeout rejects non-integer', () => {
      const result = processingSettingsSchema.safeParse({
        ...DEFAULT_SETTINGS.processing,
        postProcessingScriptTimeout: 1.5,
      });
      expect(result.success).toBe(false);
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
        minSeeders: 1,
        searchImmediately: false,
        monitorForUpgrades: false,
        rejectWords: '',
        requiredWords: '',
        preferredLanguage: '',
      });
    });
  });

  describe('processing maxConcurrentProcessing boundary constraints', () => {
    it('accepts maxConcurrentProcessing=1 (minimum)', () => {
      const result = settingsRegistry.processing.schema.safeParse({ ...DEFAULT_SETTINGS.processing, maxConcurrentProcessing: 1 });
      expect(result.success).toBe(true);
    });

    it('rejects maxConcurrentProcessing=0', () => {
      const result = settingsRegistry.processing.schema.safeParse({ ...DEFAULT_SETTINGS.processing, maxConcurrentProcessing: 0 });
      expect(result.success).toBe(false);
    });

    it('rejects negative maxConcurrentProcessing', () => {
      const result = settingsRegistry.processing.schema.safeParse({ ...DEFAULT_SETTINGS.processing, maxConcurrentProcessing: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer maxConcurrentProcessing', () => {
      const result = settingsRegistry.processing.schema.safeParse({ ...DEFAULT_SETTINGS.processing, maxConcurrentProcessing: 1.5 });
      expect(result.success).toBe(false);
    });

    it('defaults to 2 when absent', () => {
      const result = settingsRegistry.processing.schema.parse({});
      expect(result.maxConcurrentProcessing).toBe(2);
    });
  });

  describe('import minFreeSpaceGB boundary constraints', () => {
    it('accepts minFreeSpaceGB=0 (disables check)', () => {
      const result = settingsRegistry.import.schema.safeParse({ ...DEFAULT_SETTINGS.import, minFreeSpaceGB: 0 });
      expect(result.success).toBe(true);
    });

    it('rejects negative minFreeSpaceGB', () => {
      const result = settingsRegistry.import.schema.safeParse({ ...DEFAULT_SETTINGS.import, minFreeSpaceGB: -1 });
      expect(result.success).toBe(false);
    });

    it('accepts minFreeSpaceGB=5 (default)', () => {
      const result = settingsRegistry.import.schema.safeParse({ ...DEFAULT_SETTINGS.import, minFreeSpaceGB: 5 });
      expect(result.success).toBe(true);
    });

    it('defaults to 5 when absent', () => {
      const result = settingsRegistry.import.schema.parse({});
      expect(result.minFreeSpaceGB).toBe(5);
    });
  });

  describe('search blacklistTtlDays boundary constraints', () => {
    it('rejects blacklistTtlDays of 0 (below minimum)', () => {
      const result = settingsRegistry.search.schema.safeParse({ ...DEFAULT_SETTINGS.search, blacklistTtlDays: 0 });
      expect(result.success).toBe(false);
    });

    it('accepts blacklistTtlDays at minimum boundary (1)', () => {
      const result = settingsRegistry.search.schema.safeParse({ ...DEFAULT_SETTINGS.search, blacklistTtlDays: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts blacklistTtlDays at maximum boundary (365)', () => {
      const result = settingsRegistry.search.schema.safeParse({ ...DEFAULT_SETTINGS.search, blacklistTtlDays: 365 });
      expect(result.success).toBe(true);
    });

    it('rejects blacklistTtlDays above maximum (366)', () => {
      const result = settingsRegistry.search.schema.safeParse({ ...DEFAULT_SETTINGS.search, blacklistTtlDays: 366 });
      expect(result.success).toBe(false);
    });

    it('rejects negative blacklistTtlDays', () => {
      const result = settingsRegistry.search.schema.safeParse({ ...DEFAULT_SETTINGS.search, blacklistTtlDays: -1 });
      expect(result.success).toBe(false);
    });

    it('defaults to 7 when absent', () => {
      const result = settingsRegistry.search.schema.parse({});
      expect(result.blacklistTtlDays).toBe(7);
    });
  });

  describe('general housekeepingRetentionDays boundary constraints', () => {
    it('rejects housekeepingRetentionDays of 0 (below minimum)', () => {
      const result = settingsRegistry.general.schema.safeParse({ ...DEFAULT_SETTINGS.general, housekeepingRetentionDays: 0 });
      expect(result.success).toBe(false);
    });

    it('accepts housekeepingRetentionDays at minimum boundary (1)', () => {
      const result = settingsRegistry.general.schema.safeParse({ ...DEFAULT_SETTINGS.general, housekeepingRetentionDays: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts housekeepingRetentionDays at maximum boundary (365)', () => {
      const result = settingsRegistry.general.schema.safeParse({ ...DEFAULT_SETTINGS.general, housekeepingRetentionDays: 365 });
      expect(result.success).toBe(true);
    });

    it('rejects housekeepingRetentionDays above maximum (366)', () => {
      const result = settingsRegistry.general.schema.safeParse({ ...DEFAULT_SETTINGS.general, housekeepingRetentionDays: 366 });
      expect(result.success).toBe(false);
    });

    it('rejects negative housekeepingRetentionDays', () => {
      const result = settingsRegistry.general.schema.safeParse({ ...DEFAULT_SETTINGS.general, housekeepingRetentionDays: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer housekeepingRetentionDays', () => {
      const result = settingsRegistry.general.schema.safeParse({ ...DEFAULT_SETTINGS.general, housekeepingRetentionDays: 30.5 });
      expect(result.success).toBe(false);
    });

    it('defaults to 90 when absent', () => {
      const result = settingsRegistry.general.schema.parse({});
      expect(result.housekeepingRetentionDays).toBe(90);
    });
  });

  describe('rss schema boundary constraints', () => {
    it('rejects intervalMinutes below minimum (4)', () => {
      const result = settingsRegistry.rss.schema.safeParse({ intervalMinutes: 4, enabled: true });
      expect(result.success).toBe(false);
    });

    it('accepts intervalMinutes at minimum boundary (5)', () => {
      const result = settingsRegistry.rss.schema.safeParse({ intervalMinutes: 5, enabled: true });
      expect(result.success).toBe(true);
    });

    it('accepts intervalMinutes at maximum boundary (1440)', () => {
      const result = settingsRegistry.rss.schema.safeParse({ intervalMinutes: 1440, enabled: true });
      expect(result.success).toBe(true);
    });

    it('rejects intervalMinutes above maximum (1441)', () => {
      const result = settingsRegistry.rss.schema.safeParse({ intervalMinutes: 1441, enabled: true });
      expect(result.success).toBe(false);
    });
  });

  describe('system schema boundary constraints', () => {
    it('rejects backupIntervalMinutes below minimum (59)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 59, backupRetention: 7 });
      expect(result.success).toBe(false);
    });

    it('accepts backupIntervalMinutes at minimum boundary (60)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 60, backupRetention: 7 });
      expect(result.success).toBe(true);
    });

    it('accepts backupIntervalMinutes at maximum boundary (43200)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 43200, backupRetention: 7 });
      expect(result.success).toBe(true);
    });

    it('rejects backupIntervalMinutes above maximum (43201)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 43201, backupRetention: 7 });
      expect(result.success).toBe(false);
    });

    it('rejects backupRetention below minimum (0)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 10080, backupRetention: 0 });
      expect(result.success).toBe(false);
    });

    it('accepts backupRetention at minimum boundary (1)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 10080, backupRetention: 1 });
      expect(result.success).toBe(true);
    });

    it('accepts backupRetention at maximum boundary (100)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 10080, backupRetention: 100 });
      expect(result.success).toBe(true);
    });

    it('rejects backupRetention above maximum (101)', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 10080, backupRetention: 101 });
      expect(result.success).toBe(false);
    });

    it('defaults to 10080 intervalMinutes and 7 retention when absent', () => {
      const result = settingsRegistry.system.schema.parse({});
      expect(result.backupIntervalMinutes).toBe(10080);
      expect(result.backupRetention).toBe(7);
    });

    it('rejects non-integer values', () => {
      const result = settingsRegistry.system.schema.safeParse({ backupIntervalMinutes: 100.5, backupRetention: 7 });
      expect(result.success).toBe(false);
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

    it('form schema accepts NaN timeout when script path is empty', () => {
      const data = {
        ...DEFAULT_SETTINGS,
        processing: { ...DEFAULT_SETTINGS.processing, postProcessingScript: '', postProcessingScriptTimeout: Number.NaN },
      };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('form schema rejects NaN timeout when script path is non-empty', () => {
      const data = {
        ...DEFAULT_SETTINGS,
        processing: { ...DEFAULT_SETTINGS.processing, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: Number.NaN },
      };
      const result = updateSettingsFormSchema.safeParse(data);
      expect(result.success).toBe(false);
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

    it('categories with all-defaulted fields: Zod defaults match runtime defaults', () => {
      // Library has required fields (path) with no .default(), so schema.parse({}) fails — skip it
      const defaultableCategories = SETTINGS_CATEGORIES.filter(k => k !== 'library');
      for (const key of defaultableCategories) {
        const { schema, defaults } = settingsRegistry[key];
        const schemaParsed = schema.parse({});
        expect(schemaParsed, `${key} schema defaults should match registry defaults`).toEqual(defaults);
      }
    });
  });

  describe('stripDefaults behavior (via form schema)', () => {
    it('form schema rejects missing fields that have .default() in base schema', () => {
      // search.intervalMinutes has .default(360) in the base schema, so parse({}) works.
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

  describe('stripDefaults (direct export)', () => {
    it('stripDefaults(importSettingsSchema) rejects empty object (defaults not silently filled)', () => {
      const formSchema = stripDefaults(importSettingsSchema);
      const result = formSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('stripDefaults(importSettingsSchema) accepts fully-provided values', () => {
      const formSchema = stripDefaults(importSettingsSchema);
      const result = formSchema.safeParse({
        deleteAfterImport: false,
        minSeedTime: 60,
        minFreeSpaceGB: 5,
        redownloadFailed: true,
      });
      expect(result.success).toBe(true);
    });

    it('stripDefaults(importSettingsSchema) accepts minSeedTime=0 (boundary)', () => {
      const formSchema = stripDefaults(importSettingsSchema);
      const result = formSchema.safeParse({
        deleteAfterImport: false,
        minSeedTime: 0,
        minFreeSpaceGB: 0,
        redownloadFailed: true,
      });
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
        search: { intervalMinutes: 120, enabled: false, blacklistTtlDays: 14 },
      };
      const result = settingsToFormData(settings);
      expect(result.search).toEqual({ intervalMinutes: 120, enabled: false, blacklistTtlDays: 14 });
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

  describe('stripDefaults — schema derivation correctness', () => {
    it('strips .default() from fields — output schema requires values (no longer optional)', () => {
      const schema = z.object({ name: z.string().default('hi'), age: z.number().default(0) });
      const stripped = stripDefaults(schema);
      // Without defaults, missing fields should fail
      const result = stripped.safeParse({});
      expect(result.success).toBe(false);
      // With values, should pass
      const result2 = stripped.safeParse({ name: 'test', age: 5 });
      expect(result2.success).toBe(true);
    });

    it('preserves .trim().min(1) validation after stripping defaults', () => {
      const schema = z.object({ name: z.string().trim().min(1).default('hi') });
      const stripped = stripDefaults(schema);
      const result = stripped.safeParse({ name: '   ' });
      expect(result.success).toBe(false);
    });

    it('does not preserve .refine() chains on defaulted+refined fields (Zod v4 limitation)', () => {
      // This documents the known Zod v4 limitation: removeDefault() on ZodDefault<ZodRefine<...>>
      // loses the refine. Library uses an explicit form schema to work around this.
      const schema = z.object({
        name: z.string().default('x').refine((v) => v.length > 2, { message: 'too short' }),
      });
      const stripped = stripDefaults(schema);
      // The refine should reject 'ab' but after stripDefaults it's lost
      const result = stripped.safeParse({ name: 'ab' });
      expect(result.success).toBe(true); // refine is lost — this is the known limitation
    });

    it('handles ZodEnum with .default() — enum constraints preserved, default removed', () => {
      const schema = z.object({ level: z.enum(['a', 'b', 'c']).default('a') });
      const stripped = stripDefaults(schema);
      const valid = stripped.safeParse({ level: 'b' });
      expect(valid.success).toBe(true);
      const invalid = stripped.safeParse({ level: 'x' });
      expect(invalid.success).toBe(false);
      // Without value, should fail (no default)
      const missing = stripped.safeParse({});
      expect(missing.success).toBe(false);
    });
  });

  describe('hidden field preservation — general', () => {
    it('generalFormSchema omits welcomeSeen from parsed output', () => {
      const result = generalFormSchema.safeParse({
        logLevel: 'info',
        housekeepingRetentionDays: 90,
        welcomeSeen: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('welcomeSeen');
      }
    });

    it('generalFormSchema accepts valid general settings without welcomeSeen', () => {
      const result = generalFormSchema.safeParse({
        logLevel: 'debug',
        housekeepingRetentionDays: 30,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('hidden field preservation — discovery', () => {
    it('discoveryFormSchema omits weightMultipliers from parsed output', () => {
      const result = discoveryFormSchema.safeParse({
        enabled: true,
        intervalHours: 24,
        maxSuggestionsPerAuthor: 5,
        expiryDays: 90,
        snoozeDays: 30,
        weightMultipliers: { some: 0.5 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('weightMultipliers');
      }
    });

    it('discoveryFormSchema accepts valid discovery settings without weightMultipliers', () => {
      const result = discoveryFormSchema.safeParse({
        enabled: false,
        intervalHours: 48,
        maxSuggestionsPerAuthor: 10,
        expiryDays: 60,
        snoozeDays: 14,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('qualityFormSchema derivation', () => {
    it('qualityFormSchema accepts valid quality settings', () => {
      const result = qualityFormSchema.safeParse({
        grabFloor: 0,
        protocolPreference: 'none',
        minSeeders: 1,
        searchImmediately: false,
        monitorForUpgrades: false,
        rejectWords: '',
        requiredWords: '',
        preferredLanguage: '',
      });
      expect(result.success).toBe(true);
    });

    it('qualityFormSchema rejects out-of-range values', () => {
      const result = qualityFormSchema.safeParse({
        grabFloor: -1, // nonnegative
        protocolPreference: 'none',
        minSeeders: 1,
        searchImmediately: false,
        monitorForUpgrades: false,
        rejectWords: '',
        requiredWords: '',
      });
      expect(result.success).toBe(false);
    });
  });

  // Finding 4: Partial update must not inject defaults (#227)
  describe('updateSettingsSchema partial update default preservation (#227)', () => {
    it('parsing { general: { logLevel: "error" } } does NOT produce a welcomeSeen key in the output', () => {
      const result = updateSettingsSchema.safeParse({ general: { logLevel: 'error' } });
      expect(result.success).toBe(true);
      if (result.success) {
        const general = (result.data as Record<string, Record<string, unknown>>).general;
        expect(general).not.toHaveProperty('welcomeSeen');
      }
    });

    it('parsing { general: {} } produces an empty general object (no default injection)', () => {
      const result = updateSettingsSchema.safeParse({ general: {} });
      expect(result.success).toBe(true);
      if (result.success) {
        const general = (result.data as Record<string, Record<string, unknown>>).general;
        expect(Object.keys(general)).toHaveLength(0);
      }
    });

    it('parsing { search: { enabled: false } } does NOT produce intervalMinutes or blacklistTtlDays', () => {
      const result = updateSettingsSchema.safeParse({ search: { enabled: false } });
      expect(result.success).toBe(true);
      if (result.success) {
        const search = (result.data as Record<string, Record<string, unknown>>).search;
        expect(search).not.toHaveProperty('intervalMinutes');
        expect(search).not.toHaveProperty('blacklistTtlDays');
      }
    });

    it('parsing { import: { deleteAfterImport: true } } does NOT produce minSeedTime or minFreeSpaceGB', () => {
      const result = updateSettingsSchema.safeParse({ import: { deleteAfterImport: true } });
      expect(result.success).toBe(true);
      if (result.success) {
        const imp = (result.data as Record<string, Record<string, unknown>>).import;
        expect(imp).not.toHaveProperty('minSeedTime');
        expect(imp).not.toHaveProperty('minFreeSpaceGB');
      }
    });

    it('full update with all fields still applies correctly', () => {
      const result = updateSettingsSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
    });
  });
});
