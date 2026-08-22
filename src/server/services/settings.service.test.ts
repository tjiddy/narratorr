import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { SettingsService } from './settings.service.js';
import { DEFAULT_SETTINGS, SETTINGS_CATEGORIES, type SettingsCategory, type UpdateSettingsInput } from '@shared/schemas/settings/registry.js';
import { createMockSettings } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { settings, settingsMigrations } from '@db/schema.js';
import { initializeKey, _resetKey, isEncrypted } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

// createMockDb reuses one insert chain, so index both mocks by n to pair each table and row.
function getInsertCall(
  db: ReturnType<typeof createMockDb>,
  n: number,
): { table: unknown; row: unknown } {
  const tableArg = db.insert.mock.calls[n]![0];
  const chain = db.insert.mock.results[n]!.value as { values: { mock: { calls: Array<Array<unknown>> } } };
  const row = chain.values.mock.calls[n]![0];
  return { table: tableArg, row };
}

describe('SettingsService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  describe('get', () => {
    it('returns stored value when found', async () => {
      const stored = { path: '/my-audiobooks', folderFormat: '{author}/{title}' };
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: stored }]));

      const result = await service.get('library');
      expect(result).toEqual({ path: '/my-audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
    });

    it('returns default value when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('library');
      expect(result).toEqual({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
    });

    it('returns default search settings when not stored', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('search');
      expect(result).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'accuracy' });
    });

    // Fossil keys must be stripped, not rejected; parse failure would reset non-default siblings (#1345).
    it('strips removed seriesCacheRetentionDays key while preserving non-default siblings', async () => {
      const fossilGeneral = { logLevel: 'debug', housekeepingRetentionDays: 90, welcomeSeen: false, seriesCacheRetentionDays: 30 };
      db.select.mockReturnValue(mockDbChain([{ key: 'general', value: fossilGeneral }]));

      const result = await service.get('general');

      expect(result).not.toHaveProperty('seriesCacheRetentionDays');
      expect(result.logLevel).toBe('debug');
      expect(result).toEqual({ logLevel: 'debug', housekeepingRetentionDays: 90, welcomeSeen: false });
    });

    // Surviving non-defaults distinguish fossil-key stripping from full processing-category fallback (#2056).
    it('strips a stored mergeBehavior key while preserving non-default siblings', async () => {
      const log = createMockLogger();
      const svc = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const fossilProcessing = {
        outputFormat: 'mp3', keepOriginalBitrate: false, bitrate: 256, mergeBehavior: 'never',
        maxConcurrentProcessing: 4, autoMergeDownloads: true, postProcessingScript: '/x.sh', postProcessingScriptTimeout: 600,
      };
      db.select.mockReturnValue(mockDbChain([{ key: 'processing', value: fossilProcessing }]));

      const result = await svc.get('processing');

      expect(result).not.toHaveProperty('mergeBehavior');
      expect(result).toEqual({
        outputFormat: 'mp3', keepOriginalBitrate: false, bitrate: 256, maxConcurrentProcessing: 4,
        autoMergeDownloads: true, postProcessingScript: '/x.sh', postProcessingScriptTimeout: 600,
      });
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Settings parse failed'),
      );
    });
  });

  describe('getAll', () => {
    it('merges stored values with defaults', async () => {
      const customLibrary = { path: '/custom', folderFormat: '{title}' };
      db.select.mockReturnValue(
        mockDbChain([{ key: 'library', value: customLibrary }]),
      );

      const result = await service.getAll();
      expect(result.library).toEqual({ path: '/custom', folderFormat: '{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
      expect(result.search).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'accuracy' });
      expect(result.import).toEqual({ deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true });
      expect(result.general).toEqual({ logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: false });
    });

    it('returns all defaults when nothing stored', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getAll();
      expect(result.library.path).toBe('/audiobooks');
      expect(result.search.enabled).toBe(true);
      expect(result.import.deleteAfterImport).toBe(false);
      expect(result.general.logLevel).toBe('info');
    });
  });

  describe('malformed DB JSON', () => {
    it('falls back to defaults when stored value has wrong shape', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: 'not-an-object' }]));

      const result = await service.get('library');
      expect(result).toEqual({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
    });

    it('falls back to defaults when stored value has invalid field types', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: 123 } }]));

      const result = await service.get('library');
      expect(result).toEqual({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
    });

    it('getAll falls back to defaults for malformed categories', async () => {
      db.select.mockReturnValue(mockDbChain([
        { key: 'library', value: null },
        { key: 'search', value: { intervalMinutes: 'not-a-number' } },
      ]));

      const result = await service.getAll();
      expect(result.library.path).toBe('/audiobooks');
      expect(result.search.intervalMinutes).toBe(360);
    });
  });

  describe('set', () => {
    it('inserts or upserts the setting', async () => {
      const chain = mockDbChain();
      db.insert.mockReturnValue(chain);

      await service.set('library', { path: '/new', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });

      expect(db.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalled();
      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('sets each provided key and returns all settings', async () => {
      const insertChain = mockDbChain();
      db.insert.mockReturnValue(insertChain);
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.update({
        library: { path: '/updated', folderFormat: '{title}', fileFormat: '{title}' },
      });

      expect(db.insert).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.library).toBeDefined();
    });
  });

  describe('network encryption', () => {
    it('set("network") encrypts proxyUrl before storing', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.set('network', { proxyUrl: 'http://user:pass@proxy:8080' });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(isEncrypted(storedValue.proxyUrl as string)).toBe(true);
    });

    it('get("network") decrypts stored encrypted proxyUrl', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const encrypted = encrypt('http://user:pass@proxy:8080', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: encrypted } }]));

      const result = await service.get('network');

      expect(result.proxyUrl).toBe('http://user:pass@proxy:8080');
    });

    it('getAll() decrypts network proxyUrl among other categories', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const encrypted = encrypt('http://proxy:8080', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: encrypted } }]));

      const result = await service.getAll();

      expect(result.network.proxyUrl).toBe('http://proxy:8080');
    });

    it('set("network") with sentinel proxyUrl preserves existing encrypted value', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const existingEncrypted = encrypt('http://real-proxy:8080', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.set('network', { proxyUrl: '********' });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(storedValue.proxyUrl).toBe(existingEncrypted);
    });

    // Only proxyUrl is sentinel-enabled for network; any other sentinel must throw (#844).
    it('set("network") rejects sentinel on non-secret key rather than substituting it', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: 'real', stranger: 'persisted' } }]));
      db.insert.mockReturnValue(mockDbChain());

      await expect(
        service.set('network', { proxyUrl: 'real', stranger: '********' } as never),
      ).rejects.toThrow(/non-secret field: stranger/);
    });
  });

  describe('metadata.hardcoverApiKey encryption (#1133)', () => {
    it('set("metadata") encrypts hardcoverApiKey before storing', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.set('metadata', { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: 'sk-plain-1234' });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(isEncrypted(storedValue.hardcoverApiKey as string)).toBe(true);
      expect(storedValue.audibleRegion).toBe('us');
      expect(storedValue.languages).toEqual(['english']);
    });

    it('get("metadata") decrypts stored encrypted hardcoverApiKey', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const encrypted = encrypt('sk-roundtrip-7777', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: encrypted } }]));

      const result = await service.get('metadata');

      expect(result.hardcoverApiKey).toBe('sk-roundtrip-7777');
    });

    it('set("metadata") with sentinel hardcoverApiKey preserves existing encrypted value', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const existingEncrypted = encrypt('sk-existing-9999', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: existingEncrypted } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.set('metadata', { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: '********' });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(storedValue.hardcoverApiKey).toBe(existingEncrypted);
    });

    it('set("metadata") with new plaintext key replaces the previously-stored ciphertext', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const oldEncrypted = encrypt('sk-old', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: oldEncrypted } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.set('metadata', { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: 'sk-new' });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(isEncrypted(storedValue.hardcoverApiKey as string)).toBe(true);
      expect(storedValue.hardcoverApiKey).not.toBe(oldEncrypted);
    });

    it('getAll() decrypts metadata.hardcoverApiKey alongside other categories', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const encrypted = encrypt('sk-getall', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([
        { key: 'metadata', value: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: encrypted } },
      ]));

      const result = await service.getAll();
      expect(result.metadata.hardcoverApiKey).toBe('sk-getall');
    });
  });

  describe('update deep-merge', () => {
    it('preserves other fields when updating a single field in a category', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      // Selects get('search'), the sentinel lookup in set(), then getAll().
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ search: { intervalMinutes: 120 } });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 120, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' });
    });

    it('preserves other flat fields in quality when updating minSeeders', async () => {
      const existingQuality = { grabFloor: 10, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, rejectWords: '', requiredWords: '' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'quality', value: existingQuality }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ quality: { minSeeders: 5 } });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toMatchObject({ grabFloor: 10, protocolPreference: 'none', minSeeders: 5 });
    });

    it('preserves sibling quality fields when updating maxDownloadSize', async () => {
      const existingQuality = { grabFloor: 10, protocolPreference: 'none', minSeeders: 3, maxDownloadSize: 5, searchImmediately: false, rejectWords: '', requiredWords: '' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'quality', value: existingQuality }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ quality: { maxDownloadSize: 10 } });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toMatchObject({ grabFloor: 10, protocolPreference: 'none', minSeeders: 3, maxDownloadSize: 10 });
    });

    it('works with a full category object (backward compat)', async () => {
      const full = { intervalMinutes: 120, enabled: false, blacklistTtlDays: 14, searchPriority: 'quality' as const };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' } }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ search: full });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual(full);
    });

    it('results in no changes for empty partial object', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('skips category when value is undefined', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('patch', () => {
    it('preserves existing intervalMinutes and blacklistTtlDays when patching enabled', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
      expect(result).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
    });

    it('no-migration: stored keepOriginalBitrate: false survives a patch of an unrelated field', async () => {
      // A pre-1.0 keep-original opt-out must survive the later default flip.
      const existingProcessing = { ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 256, maxConcurrentProcessing: 1, postProcessingScript: '', postProcessingScriptTimeout: 300 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'processing', value: existingProcessing }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('processing', { bitrate: 192 });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue.keepOriginalBitrate).toBe(false);
      expect(storedValue.bitrate).toBe(192);
      expect(result.keepOriginalBitrate).toBe(false);
    });

    it('preserves existing deleteAfterImport and minSeedTime when patching minFreeSpaceGB', async () => {
      const existingImport = { deleteAfterImport: true, minSeedTime: 120, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'import', value: existingImport }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('import', { minFreeSpaceGB: 10 });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ deleteAfterImport: true, minSeedTime: 120, minSeedRatio: 0, minFreeSpaceGB: 10, redownloadFailed: true });
      expect(result).toEqual({ deleteAfterImport: true, minSeedTime: 120, minSeedRatio: 0, minFreeSpaceGB: 10, redownloadFailed: true });
    });

    it('stores falsy value 0, not the default', async () => {
      const existingImport = { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'import', value: existingImport }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('import', { minFreeSpaceGB: 0 });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue.minFreeSpaceGB).toBe(0);
      expect(result.minFreeSpaceGB).toBe(0);
    });

    it('stores falsy value false, not the default', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue.enabled).toBe(false);
      expect(result.enabled).toBe(false);
    });

    it('empty partial is a no-op — returns existing values unchanged without DB write', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]));

      const result = await service.patch('search', {});

      expect(result).toEqual(existingSearch);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('merges into defaults when no existing DB row', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'accuracy' });
      expect(result).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'accuracy' });
    });

    it('sentinel passthrough preserves existing encrypted value', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const existingEncrypted = encrypt('http://real-proxy:8080', TEST_KEY);
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]))
        .mockReturnValueOnce(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.patch('network', { proxyUrl: '********' });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(storedValue.proxyUrl).toBe(existingEncrypted);
    });
  });

  describe('update with UpdateSettingsInput', () => {
    it('accepts partial category values via UpdateSettingsInput', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { search: { enabled: false } };
      await service.update(input);

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
    });

    it('returns all settings without DB writes for empty input', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('preserves welcomeSeen when patching logLevel in general category', async () => {
      const existingGeneral = { logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: true };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'general', value: existingGeneral }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { general: { logLevel: 'debug' } };
      await service.update(input);

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ logLevel: 'debug', housekeepingRetentionDays: 90, welcomeSeen: true });
    });

    it('stores welcomeSeen: false when only welcomeSeen is patched', async () => {
      const existingGeneral = { logLevel: 'info', housekeepingRetentionDays: 90, welcomeSeen: true };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'general', value: existingGeneral }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { general: { welcomeSeen: false } };
      await service.update(input);

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue.welcomeSeen).toBe(false);
      expect(storedValue.logLevel).toBe('info');
      expect(storedValue.housekeepingRetentionDays).toBe(90);
    });
  });
});

describe('SettingsService.get(processing) — forward-compat', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  it('getLegacyFfmpegPath returns a non-empty stored ffmpegPath, undefined otherwise', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ key: 'processing', value: { ffmpegPath: '/opt/custom/ffmpeg', outputFormat: 'm4b' } }]));
    expect(await service.getLegacyFfmpegPath()).toBe('/opt/custom/ffmpeg');

    db.select.mockReturnValueOnce(mockDbChain([{ key: 'processing', value: { ffmpegPath: '   ', outputFormat: 'm4b' } }]));
    expect(await service.getLegacyFfmpegPath()).toBeUndefined();

    db.select.mockReturnValueOnce(mockDbChain([{ key: 'processing', value: { outputFormat: 'm4b' } }]));
    expect(await service.getLegacyFfmpegPath()).toBeUndefined();

    db.select.mockReturnValueOnce(mockDbChain([]));
    expect(await service.getLegacyFfmpegPath()).toBeUndefined();
  });


  it('forward-compat: historical row with enabled=true returns parsed object without enabled key', async () => {
    db.select.mockReturnValue(mockDbChain([{ key: 'processing', value: { enabled: true, outputFormat: 'mp3' } }]));

    const result = await service.get('processing');

    expect(result.outputFormat).toBe('mp3');
    expect(result).not.toHaveProperty('enabled');
  });
});

describe('migrateLanguageSettings', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    _resetKey();
  });

  it('migrates non-empty preferredLanguage to metadata.languages', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: 'spanish', rejectWords: 'abridged' } }]);
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    const insertCalls = db.insert.mock.calls;
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips migration when preferredLanguage is empty string', async () => {
    db.select.mockImplementation(() => {
      return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
    });
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: '' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    const insertCalls = db.insert.mock.calls;
    expect(insertCalls.length).toBe(1);
  });

  it('skips migration when preferredLanguage is missing', async () => {
    db.select.mockImplementation(() => mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]));
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0 } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    expect(db.insert.mock.calls.length).toBe(1);
  });

  it('skips migration when metadata.languages already exists (idempotency)', async () => {
    db.select.mockReturnValue(mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us', languages: ['french'] } }]));

    await service.migrateLanguageSettings();

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('preserves existing protocolPreference, rejectWords, requiredWords in quality blob', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 10, protocolPreference: 'torrent', rejectWords: 'abridged', requiredWords: 'unabridged', preferredLanguage: 'german' } }]);
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    expect(db.insert.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('removes preferredLanguage from quality blob after migration', async () => {
    const qualityBlob = { grabFloor: 0, preferredLanguage: 'spanish', rejectWords: '' };
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: qualityBlob }]);
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    expect(db.insert).toHaveBeenCalled();
  });

  it('normalizes non-canonical legacy value (e.g. ISO code) to canonical name before writing', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: 'eng' } }]);
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    expect(db.insert.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips metadata write for non-canonical legacy value (e.g. misspelling) but still cleans up quality blob', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: 'klingon' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ preferredLanguage: 'klingon' }),
      expect.stringContaining('not a canonical language'),
    );
    expect(db.insert.mock.calls.length).toBe(1);
  });

  it('logs warning and does not block startup on migration error', async () => {
    db.select.mockImplementation(() => { throw new Error('DB connection failed'); });

    await service.migrateLanguageSettings();

    expect(log.warn).toHaveBeenCalled();
  });
});

describe('migrateRejectWordsDefault', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;
  const NEW_DEFAULT = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged';
  const FLAG_ID = 'rejectWords-defaults-v1';

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  it('writes new default rejectWords when stored quality.rejectWords is empty string (legacy)', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    expect(db.insert.mock.calls.length).toBe(2);
    const qualityWrite = getInsertCall(db, 0);
    expect(qualityWrite.table).toBe(settings);
    expect(qualityWrite.row).toMatchObject({ key: 'quality', value: expect.objectContaining({ rejectWords: NEW_DEFAULT, grabFloor: 0 }) });

    const flagWrite = getInsertCall(db, 1);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
    // #2561: marker read, work and marker write share ONE transaction — the pre-transaction
    // marker read was the non-atomic check-then-act template the add-ledger backfill copied.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('skips quality write when stored rejectWords is non-empty (user customized) but still marks flag applied with the correct id', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: 'My Custom Word' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    const flagWrite = getInsertCall(db, 0);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
  });

  it('skips quality write and marks flag applied with the correct id when no quality row exists', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    const flagWrite = getInsertCall(db, 0);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
  });

  it('end-to-end: no-row install -> migration sets flag -> user later clears rejectWords -> rerun does not re-migrate', async () => {
    let phase1Calls = 0;
    db.select.mockImplementation(() => {
      phase1Calls++;
      if (phase1Calls === 1) return mockDbChain([]);
      if (phase1Calls === 2) return mockDbChain([]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });

    db.insert.mockClear();
    db.select.mockReset();
    db.select.mockReturnValueOnce(mockDbChain([{ id: FLAG_ID, appliedAt: new Date() }]));

    await service.migrateRejectWordsDefault();

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: returns early when migration flag is already set', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ id: 'rejectWords-defaults-v1', appliedAt: new Date() }]));

    await service.migrateRejectWordsDefault();

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('post-migration user-cleared empty string is preserved (does not re-migrate)', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ id: 'rejectWords-defaults-v1', appliedAt: new Date() }]));

    await service.migrateRejectWordsDefault();

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('logs warning and does not throw on DB error', async () => {
    db.select.mockImplementation(() => { throw new Error('DB connection failed'); });
    const log = createMockLogger();
    const failingService = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));

    await failingService.migrateRejectWordsDefault();

    expect(log.warn).toHaveBeenCalled();
  });

  it('preserves other quality fields when overwriting empty rejectWords', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 50, protocolPreference: 'torrent', minSeeders: 10, rejectWords: '', requiredWords: 'M4B' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    const qualityWrite = getInsertCall(db, 0);
    expect(qualityWrite.table).toBe(settings);
    expect((qualityWrite.row as { value: Record<string, unknown> }).value).toEqual({
      grabFloor: 50,
      protocolPreference: 'torrent',
      minSeeders: 10,
      rejectWords: NEW_DEFAULT,
      requiredWords: 'M4B',
    });
    const flagWrite = getInsertCall(db, 1);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
  });

  it('invalidates quality cache after legacy-default write', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      // Prime legacy cache, check the flag, read the raw row, then expose the migrated row after invalidation.
      if (callCount === 1) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      if (callCount === 2) return mockDbChain([]);
      if (callCount === 3) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: NEW_DEFAULT } }]);
    });
    db.insert.mockReturnValue(mockDbChain());

    const before = await service.get('quality');
    expect(before.rejectWords).toBe('');

    await service.migrateRejectWordsDefault();

    const after = await service.get('quality');
    expect(after.rejectWords).toBe(NEW_DEFAULT);
  });
});

describe('migrateRejectWordsAbridgedDefault (#993)', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;
  const OLD_PACKAGED_DEFAULT = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes';
  const NEW_PACKAGED_DEFAULT = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged';
  const FLAG_ID = 'rejectWords-defaults-v2-abridged';

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  it('writes new default when stored rejectWords is exactly the OLD packaged default', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: OLD_PACKAGED_DEFAULT } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsAbridgedDefault();

    expect(db.insert.mock.calls.length).toBe(2);
    const qualityWrite = getInsertCall(db, 0);
    expect(qualityWrite.table).toBe(settings);
    expect(qualityWrite.row).toMatchObject({ key: 'quality', value: expect.objectContaining({ rejectWords: NEW_PACKAGED_DEFAULT, grabFloor: 0 }) });

    const flagWrite = getInsertCall(db, 1);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
    expect(db.transaction).toHaveBeenCalledTimes(1); // #2561: wrapper opened (see mock-db-tx-handle-is-the-db)
  });

  it('skips quality write when user customized rejectWords (anything other than OLD default), but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: 'Virtual Voice, Free Excerpt' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsAbridgedDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    const flagWrite = getInsertCall(db, 0);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
  });

  it('skips quality write when stored rejectWords is empty (deliberately cleared post-v1), but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsAbridgedDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('skips quality write when already on the new default, but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: NEW_PACKAGED_DEFAULT } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsAbridgedDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('skips quality write when no quality row exists, but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsAbridgedDefault();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('is idempotent: returns early when v2 flag is already set, no quality row read', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ id: FLAG_ID, appliedAt: new Date() }]));

    await service.migrateRejectWordsAbridgedDefault();

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('preserves other quality fields when upgrading the OLD default', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 50, protocolPreference: 'torrent', minSeeders: 10, rejectWords: OLD_PACKAGED_DEFAULT, requiredWords: 'M4B' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsAbridgedDefault();

    const qualityWrite = getInsertCall(db, 0);
    expect(qualityWrite.table).toBe(settings);
    expect((qualityWrite.row as { value: Record<string, unknown> }).value).toEqual({
      grabFloor: 50,
      protocolPreference: 'torrent',
      minSeeders: 10,
      rejectWords: NEW_PACKAGED_DEFAULT,
      requiredWords: 'M4B',
    });
  });

  it('logs warning and does not throw on DB error', async () => {
    db.select.mockImplementation(() => { throw new Error('DB connection failed'); });
    const log = createMockLogger();
    const failingService = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));

    await failingService.migrateRejectWordsAbridgedDefault();

    expect(log.warn).toHaveBeenCalled();
  });
});

describe('migrateMaxConcurrentProcessingDefaults (#1367)', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;
  const FLAG_ID = 'maxConcurrentProcessing-defaults-v1';

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  it('rewrites stored maxConcurrentProcessing=2 to 1, preserving other fields, and marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 2, postProcessingScript: '/x.sh' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(2);
    const processingWrite = getInsertCall(db, 0);
    expect(processingWrite.table).toBe(settings);
    expect((processingWrite.row as { value: Record<string, unknown> }).value).toEqual({
      ffmpegPath: '/usr/bin/ffmpeg',
      maxConcurrentProcessing: 1,
      postProcessingScript: '/x.sh',
    });

    const flagWrite = getInsertCall(db, 1);
    expect(flagWrite.table).toBe(settingsMigrations);
    expect(flagWrite.row).toEqual({ id: FLAG_ID });
    expect(db.transaction).toHaveBeenCalledTimes(1); // #2561: wrapper opened (see mock-db-tx-handle-is-the-db)
  });

  it('clamps a raw stored value >8 to 8 (rescuing the category), reading the raw blob not parseCategory', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      // Value 10 fails Zod's max(8), so the migration must read the raw blob.
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 10, postProcessingScript: '/x.sh' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(2);
    const processingWrite = getInsertCall(db, 0);
    expect(processingWrite.table).toBe(settings);
    expect((processingWrite.row as { value: Record<string, unknown> }).value).toEqual({
      ffmpegPath: '/usr/bin/ffmpeg',
      maxConcurrentProcessing: 8,
      postProcessingScript: '/x.sh',
    });
    expect(getInsertCall(db, 1).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 1).row).toEqual({ id: FLAG_ID });
  });

  it('logs at info with migration metadata when it rewrites 2 -> 1', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 2 } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());
    const log = createMockLogger();
    const loggingService = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));

    await loggingService.migrateMaxConcurrentProcessingDefaults();

    expect(log.info).toHaveBeenCalledWith(
      { migration: FLAG_ID, from: 2, to: 1 },
      'Migrated stored maxConcurrentProcessing',
    );
  });

  it('logs at info with migration metadata when it clamps >8 -> 8', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 10 } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());
    const log = createMockLogger();
    const loggingService = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));

    await loggingService.migrateMaxConcurrentProcessingDefaults();

    expect(log.info).toHaveBeenCalledWith(
      { migration: FLAG_ID, from: 10, to: 8 },
      'Migrated stored maxConcurrentProcessing',
    );
  });

  it('leaves an in-range deliberate value (4) untouched but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 4 } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('leaves a stored value of 1 untouched but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { maxConcurrentProcessing: 1 } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('marks flag applied with the correct id when no processing row exists', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('does not rewrite when the field is missing or a non-numeric "2" string, but marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });

    db.insert.mockClear();
    db.select.mockReset();
    callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]);
      if (callCount === 2) return mockDbChain([{ key: 'processing', value: { maxConcurrentProcessing: '2' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);
    expect(getInsertCall(db, 0).row).toEqual({ id: FLAG_ID });
  });

  it('is idempotent: returns early when the flag is already set, no processing read, value stays 2', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ id: FLAG_ID, appliedAt: new Date() }]));

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('end-to-end: no-row install sets flag -> user later stores 2 -> rerun does not re-flip it', async () => {
    let phase1 = 0;
    db.select.mockImplementation(() => {
      phase1++;
      if (phase1 === 1) return mockDbChain([]);
      if (phase1 === 2) return mockDbChain([]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert.mock.calls.length).toBe(1);
    expect(getInsertCall(db, 0).table).toBe(settingsMigrations);

    db.insert.mockClear();
    db.select.mockReset();
    db.select.mockReturnValueOnce(mockDbChain([{ id: FLAG_ID, appliedAt: new Date() }]));

    await service.migrateMaxConcurrentProcessingDefaults();

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('invalidates processing cache after a rewrite', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 2 } }]);
      if (callCount === 2) return mockDbChain([]);
      if (callCount === 3) return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 2 } }]);
      return mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg', maxConcurrentProcessing: 1 } }]);
    });
    db.insert.mockReturnValue(mockDbChain());

    const before = await service.get('processing');
    expect(before.maxConcurrentProcessing).toBe(2);

    await service.migrateMaxConcurrentProcessingDefaults();

    const after = await service.get('processing');
    expect(after.maxConcurrentProcessing).toBe(1);
  });

  it('logs warning and does not throw on DB error, leaving the flag unwritten', async () => {
    db.select.mockImplementation(() => { throw new Error('DB connection failed'); });
    const log = createMockLogger();
    const failingService = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));

    await failingService.migrateMaxConcurrentProcessingDefaults();

    expect(log.warn).toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('SettingsService — cache (#554)', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: SettingsService;

  /** A complete row set — the only shape getAll() may cache once a missing row is uncacheable (#2451). */
  function allCategoryRows(overrides?: Partial<Record<SettingsCategory, unknown>>): Array<{ key: string; value: unknown }> {
    const all = createMockSettings();
    return SETTINGS_CATEGORIES.map((key) => ({
      key,
      value: overrides && key in overrides ? overrides[key] : all[key],
    }));
  }

  // Isolates parse fallbacks from the decrypt and migration warnings sharing this logger.
  function parseWarns(): Array<Array<unknown>> {
    return (log.warn as Mock).mock.calls.filter(
      (call) => call[1] === 'Settings parse failed, using defaults',
    );
  }

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    _resetKey();
  });

  describe('cache hit/miss', () => {
    it('returns correct value from DB on first call (cache miss)', async () => {
      const stored = { path: '/my-audiobooks', folderFormat: '{author}/{title}' };
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: stored }]));

      const result = await service.get('library');
      expect(result.path).toBe('/my-audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('returns cached value on second call within TTL without DB query (cache hit)', async () => {
      const stored = { path: '/my-audiobooks', folderFormat: '{author}/{title}' };
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: stored }]));

      await service.get('library');
      expect(db.select).toHaveBeenCalledTimes(1);

      db.select.mockClear();
      const result2 = await service.get('library');
      expect(result2.path).toBe('/my-audiobooks');
      expect(db.select).not.toHaveBeenCalled();
    });

    it('caches different categories independently', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/lib' } }]))
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: { intervalMinutes: 120 } }]));

      const lib = await service.get('library');
      const search = await service.get('search');
      expect(lib.path).toBe('/lib');
      expect(search.intervalMinutes).toBe(120);
      expect(db.select).toHaveBeenCalledTimes(2);

      db.select.mockClear();
      const lib2 = await service.get('library');
      const search2 = await service.get('search');
      expect(lib2.path).toBe('/lib');
      expect(search2.intervalMinutes).toBe(120);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('getAll() caches aggregate independently from per-category cache', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: { path: '/lib' } })));

      await service.getAll();
      expect(db.select).toHaveBeenCalledTimes(1);

      db.select.mockClear();
      await service.getAll();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('getAll() returns cached aggregate on second call within TTL', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: { path: '/custom' } })));

      const first = await service.getAll();
      db.select.mockClear();
      const second = await service.getAll();
      expect(second.library.path).toBe(first.library.path);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('cache invalidation — per-category and aggregate', () => {
    it('set() invalidates per-category cache; subsequent get() returns fresh value', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/old' } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.get('library');
      db.select.mockClear();

      await service.set('library', { path: '/new', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space' as const, namingCase: 'default' as const });

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/new' } }]));
      const result = await service.get('library');
      expect(result.path).toBe('/new');
      expect(db.select).toHaveBeenCalled();
    });

    it('set() invalidates getAll() aggregate cache', async () => {
      // All 13 rows: a partial set is uncacheable post-#2451, which would pass this for the wrong reason.
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: { path: '/old' } })));
      db.insert.mockReturnValue(mockDbChain());

      await service.getAll();
      db.select.mockClear();

      await service.set('library', { path: '/new', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space' as const, namingCase: 'default' as const });

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/new' } }]));
      await service.getAll();
      expect(db.select).toHaveBeenCalled();
    });

    it('patch() invalidates per-category cache', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/old' } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.get('library');
      db.select.mockClear();

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/old' } }]));
      await service.patch('library', { path: '/patched' });
      db.select.mockClear();

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/patched' } }]));
      const result = await service.get('library');
      expect(result.path).toBe('/patched');
      expect(db.select).toHaveBeenCalled();
    });

    it('patch() invalidates getAll() aggregate cache', async () => {
      // All 13 rows: a partial set is uncacheable post-#2451, which would pass this for the wrong reason.
      db.select.mockReturnValue(mockDbChain(allCategoryRows()));
      db.insert.mockReturnValue(mockDbChain());

      await service.getAll();
      db.select.mockClear();

      db.select.mockReturnValue(mockDbChain([]));
      await service.patch('library', { path: '/patched' });
      db.select.mockClear();

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/patched' } }]));
      await service.getAll();
      expect(db.select).toHaveBeenCalled();
    });

    it('migrateLanguageSettings() invalidates quality cache after cleanup write', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'quality', value: { minBitrate: 64 } }]));
      await service.get('quality');
      db.select.mockClear();

      // With no preferredLanguage, only the cleanup write can invalidate the quality cache.
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'metadata', value: {} }]))
        .mockReturnValueOnce(mockDbChain([{ key: 'quality', value: { minBitrate: 64 } }]));
      db.insert.mockReturnValue(mockDbChain());
      await service.migrateLanguageSettings();
      db.select.mockClear();

      db.select.mockReturnValue(mockDbChain([{ key: 'quality', value: { minBitrate: 64 } }]));
      await service.get('quality');
      expect(db.select).toHaveBeenCalled();
    });

    it('update() returns fresh aggregate reflecting the write', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/updated', folderFormat: '{author}/{title}' } }]));

      const result = await service.update({ library: { path: '/updated' } } as UpdateSettingsInput);
      expect(result.library.path).toBe('/updated');
    });
  });

  describe('TTL expiry', () => {
    it('cached value expires after 30s; get() after expiry hits DB again', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));

      await service.get('library');
      db.select.mockClear();

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));
      await service.get('library');
      expect(db.select).toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('cache expiry is per-key — key A expiring does not expire key B', async () => {
      const baseNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(baseNow);

      db.select.mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));
      await service.get('library');

      vi.spyOn(Date, 'now').mockReturnValue(baseNow + 15_000);
      db.select.mockReturnValueOnce(mockDbChain([{ key: 'search', value: { intervalMinutes: 120 } }]));
      await service.get('search');

      // At +31s library is expired, while search is only 16s old.
      vi.spyOn(Date, 'now').mockReturnValue(baseNow + 31_000);
      db.select.mockClear();

      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));
      await service.get('library');
      expect(db.select).toHaveBeenCalledTimes(1);

      db.select.mockClear();
      await service.get('search');
      expect(db.select).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('getAll() aggregate cache has independent TTL', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows()));

      await service.getAll();
      db.select.mockClear();

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);

      await service.getAll();
      expect(db.select).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  describe('boundary values', () => {
    it('get() for category with no DB row returns DEFAULT_SETTINGS', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('library');
      expect(result.path).toBe('/audiobooks');
      db.select.mockClear();

      const result2 = await service.get('library');
      expect(result2.path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalled();
    });

    it('get() for category with malformed JSON returns default via safeParse fallback', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: 'not-an-object' }]));

      const result = await service.get('library');
      expect(result.path).toBe('/audiobooks');
      db.select.mockClear();

      const result2 = await service.get('library');
      expect(result2.path).toBe('/audiobooks');
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  /**
   * The select count is the observation point throughout: `categoryCache` is private, so an
   * assertion reading it through a cast would pin the implementation rather than the behavior.
   */
  describe('get() — a missing row is never cached (#2451)', () => {
    it('returns defaults and re-reads the DB on the next call', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      expect((await service.get('library')).path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);

      db.select.mockClear();
      expect((await service.get('library')).path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    // Counts, not "called again": a cache-with-zero-TTL half-fix still coalesces within one tick.
    it('three consecutive misses issue exactly three selects', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      await service.get('library');
      await service.get('library');
      await service.get('library');

      expect(db.select).toHaveBeenCalledTimes(3);
    });

    it('sees a row written by another connection with no invalidation call', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/from-other-connection' } }]));

      expect((await service.get('library')).path).toBe('/audiobooks');
      expect((await service.get('library')).path).toBe('/from-other-connection');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('leaves a present category cached while a missing one keeps re-reading', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: { intervalMinutes: 120 } }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.get('library');
      await service.get('search');
      db.select.mockClear();

      expect((await service.get('search')).intervalMinutes).toBe(120);
      expect(db.select).not.toHaveBeenCalled();

      expect((await service.get('library')).path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    /**
     * Catches a fix gated on cache-entry absence instead of row absence: an expired entry lingers
     * (get() compares `expiresAt` without deleting), so such an implementation would refresh it into
     * a fresh 30s defaults entry here while the empty-map miss cases above stay green.
     */
    it('never refreshes a lingering expired entry when the row has vanished', async () => {
      const baseNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(baseNow);
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/stored' } }]));
      expect((await service.get('library')).path).toBe('/stored');

      vi.spyOn(Date, 'now').mockReturnValue(baseNow + 31_000);
      db.select.mockReturnValue(mockDbChain([]));
      db.select.mockClear();

      expect((await service.get('library')).path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);

      db.select.mockClear();
      expect((await service.get('library')).path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });

    it('patch() on a never-written category persists the merge without mutating DEFAULT_SETTINGS', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const merged = await service.patch('library', { path: '/patched' });

      expect(merged).toEqual({ ...DEFAULT_SETTINGS.library, path: '/patched' });
      expect(getInsertCall(db, 0).row).toEqual({
        key: 'library',
        value: { ...DEFAULT_SETTINGS.library, path: '/patched' },
      });
      expect(DEFAULT_SETTINGS.library.path).toBe('/audiobooks');
    });

    it('two concurrent misses both return defaults and both select — no coalescing guard', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const [a, b] = await Promise.all([service.get('library'), service.get('library')]);

      expect(a.path).toBe('/audiobooks');
      expect(b.path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('getAll() — a partial composition is never cached (#2451)', () => {
    it('composes full defaults from zero rows and does not cache them', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const first = await service.getAll();
      expect(Object.keys(first).sort()).toEqual([...SETTINGS_CATEGORIES].sort());
      expect(first.library.path).toBe('/audiobooks');

      db.select.mockClear();
      await service.getAll();
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    // The boundary a naive `results.length === 0` check would miss.
    it('does not cache when a single category is absent', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows().filter((r) => r.key !== 'companionEpub')));

      const first = await service.getAll();
      expect(first.companionEpub).toEqual(DEFAULT_SETTINGS.companionEpub);

      db.select.mockClear();
      await service.getAll();
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('caches and expires on the 30s TTL when every category is present', async () => {
      const baseNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(baseNow);
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: { path: '/all' } })));

      expect((await service.getAll()).library.path).toBe('/all');
      db.select.mockClear();
      await service.getAll();
      expect(db.select).not.toHaveBeenCalled();

      vi.spyOn(Date, 'now').mockReturnValue(baseNow + 31_000);
      await service.getAll();
      expect(db.select).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });

    it('decides on row presence, not parse fallback — an all-present set with a malformed row caches', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: 'not-an-object' })));

      expect((await service.getAll()).library).toEqual(DEFAULT_SETTINGS.library);

      db.select.mockClear();
      await service.getAll();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('sees a row written by another connection for a previously-absent category', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/from-other-connection' } }]));

      expect((await service.getAll()).library.path).toBe('/audiobooks');
      expect((await service.getAll()).library.path).toBe('/from-other-connection');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('keeps categoryCache and allCache independent in both directions', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));
      await service.getAll();
      db.select.mockClear();

      // The uncached aggregate populated no per-category entry.
      db.select.mockReturnValueOnce(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));
      expect((await service.get('library')).path).toBe('/lib');
      expect(db.select).toHaveBeenCalledTimes(1);

      // And that live per-category entry cannot satisfy getAll().
      db.select.mockClear();
      db.select.mockReturnValueOnce(mockDbChain(allCategoryRows()));
      await service.getAll();
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('parse-warning cadence (#2451)', () => {
    it('warns once per DB read-through for a malformed present row', async () => {
      const baseNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(baseNow);
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: 'not-an-object' }]));

      expect((await service.get('library')).path).toBe('/audiobooks');
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(parseWarns()).toHaveLength(1);

      db.select.mockClear();
      await service.get('library');
      expect(db.select).not.toHaveBeenCalled();
      expect(parseWarns()).toHaveLength(1);

      vi.spyOn(Date, 'now').mockReturnValue(baseNow + 31_000);
      await service.get('library');
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(parseWarns()).toHaveLength(2);

      vi.restoreAllMocks();
    });

    // Losing the cache write must not turn a re-read into log volume.
    it('never warns from the miss arm, however often it re-reads', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      await service.get('library');
      await service.get('library');
      await service.get('library');

      expect(db.select).toHaveBeenCalledTimes(3);
      expect(parseWarns()).toHaveLength(0);
    });

    // Accepted consequence of the uncached partial aggregate; deliberately not deduplicated.
    it('re-warns per getAll() when a malformed row shares the DB with an absent category', async () => {
      db.select.mockReturnValue(mockDbChain(
        allCategoryRows({ library: 'not-an-object' }).filter((r) => r.key !== 'companionEpub'),
      ));

      await service.getAll();
      await service.getAll();

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(parseWarns()).toHaveLength(2);
    });

    it('warns once per TTL window for the same malformed row when every category is present', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: 'not-an-object' })));

      await service.getAll();
      await service.getAll();

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(parseWarns()).toHaveLength(1);
    });
  });

  /**
   * The caller owns what get()/getAll() hand back. Returning the shared DEFAULT_SETTINGS entry let
   * one caller's mutation corrupt the packaged defaults process-wide, for every later miss in every
   * service — permanently, unlike the TTL-bounded sharing of a cached value (#2455).
   */
  describe('fallback returns are copies, never the packaged defaults (#2455)', () => {
    // A red run of the mutation cases really does corrupt the module-level defaults, so restore them
    // between tests: a counterfactual then reds the assertions under test, not every later suite.
    const PRISTINE = structuredClone(DEFAULT_SETTINGS);
    afterEach(() => {
      for (const key of SETTINGS_CATEGORIES) {
        Object.assign(
          DEFAULT_SETTINGS[key] as unknown as Record<string, unknown>,
          structuredClone(PRISTINE[key]) as unknown as Record<string, unknown>,
        );
      }
    });

    it('get() on a missing row returns a copy of the category default', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('library');

      expect(result).toEqual(DEFAULT_SETTINGS.library);
      expect(result).not.toBe(DEFAULT_SETTINGS.library);
    });

    // A present row, so a no-row-only fix stays red here.
    it('get() on a stored JSON null returns a copy', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: null }]));

      const result = await service.get('library');

      expect(result).toEqual(DEFAULT_SETTINGS.library);
      expect(result).not.toBe(DEFAULT_SETTINGS.library);
    });

    it('get() on a malformed row returns a copy and still warns', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: 'not-an-object' }]));

      const result = await service.get('library');

      expect(result).toEqual(DEFAULT_SETTINGS.library);
      expect(result).not.toBe(DEFAULT_SETTINGS.library);
      expect(parseWarns()).toHaveLength(1);
    });

    // metadata.languages is the only container-valued default, so it is what a shallow spread misses.
    it('copies nested containers, not just the category object', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('metadata');

      expect(result.languages).toEqual(['english']);
      expect(result.languages).not.toBe(DEFAULT_SETTINGS.metadata.languages);
    });

    it('assigning to a missed get() result leaves the defaults and the next read pristine', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const held = await service.get('library');
      held.path = '/hacked';

      expect(DEFAULT_SETTINGS.library.path).toBe('/audiobooks');
      expect((await service.get('library')).path).toBe('/audiobooks');
    });

    it('pushing to a missed get() array leaves metadata.languages at its one packaged entry', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const held = await service.get('metadata');
      held.languages.push('german');

      expect(DEFAULT_SETTINGS.metadata.languages).toEqual(['english']);
    });

    // Instance caches are per-service; the defaults are a module export, so the guarantee has to hold
    // across instances or it is only accidentally scoped by the per-test cache.
    it('a mutation through one service cannot reach a fresh instance over a fresh db', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      (await service.get('library')).path = '/hacked';

      const otherDb = createMockDb();
      otherDb.select.mockReturnValue(mockDbChain([]));
      const other = new SettingsService(inject<Db>(otherDb), inject<FastifyBaseLogger>(createMockLogger()));

      expect((await other.get('library')).path).toBe('/audiobooks');
    });

    // Catches a module-level `const COPY = structuredClone(DEFAULT_SETTINGS)` half-fix: it stops
    // aliasing the defaults but still shares one object between every caller on the miss path.
    it('two successive misses return two distinct objects', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const first = await service.get('library');
      const second = await service.get('library');

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });

    it('two concurrent misses resolve to distinct copies', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const [a, b] = await Promise.all([service.get('library'), service.get('library')]);

      expect(a).not.toBe(b);
      expect(a).not.toBe(DEFAULT_SETTINGS.library);
      expect(b).not.toBe(DEFAULT_SETTINGS.library);
    });

    it('getAll() over zero rows returns a copy for every registered category', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const all = await service.getAll();

      for (const key of SETTINGS_CATEGORIES) {
        expect(all[key], key).toEqual(DEFAULT_SETTINGS[key]);
        expect(all[key], key).not.toBe(DEFAULT_SETTINGS[key]);
      }
    });

    // The one composition getAll() does pin for a full TTL, so a shared reference here would be a
    // corruption held in the cache rather than one that merely passes through.
    it('getAll() caches the copy, not the defaults, for an all-present set with one malformed row', async () => {
      db.select.mockReturnValue(mockDbChain(allCategoryRows({ library: 'not-an-object' })));

      const all = await service.getAll();
      expect(all.library).not.toBe(DEFAULT_SETTINGS.library);

      all.library.path = '/hacked';
      expect(DEFAULT_SETTINGS.library.path).toBe('/audiobooks');
    });

    it('a mutation through getAll() cannot reach a later get() on a fresh instance', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      (await service.getAll()).metadata.languages.push('german');

      const otherDb = createMockDb();
      otherDb.select.mockReturnValue(mockDbChain([]));
      const other = new SettingsService(inject<Db>(otherDb), inject<FastifyBaseLogger>(createMockLogger()));

      expect((await other.get('metadata')).languages).toEqual(['english']);
    });

    // The secret categories decrypt a spread of the raw row before parsing; the fallback still has to
    // hand back a copy on both arms it can reach.
    it('a secret category returns a copy on both the missing-row and the failed-parse arm', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      expect(await service.get('metadata')).not.toBe(DEFAULT_SETTINGS.metadata);

      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: 42 } }]));
      const network = await service.get('network');

      expect(network).toEqual(DEFAULT_SETTINGS.network);
      expect(network).not.toBe(DEFAULT_SETTINGS.network);
    });

    // Scope, stated honestly: within a live TTL a cached category is still one object shared by every
    // caller. That sharing is deliberate and expires; only the permanent defaults aliasing is the bug.
    it('still returns one shared object for repeated cache hits on a malformed row', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: 'not-an-object' }]));

      const first = await service.get('library');
      const second = await service.get('library');

      expect(second).toBe(first);
      expect(db.select).toHaveBeenCalledTimes(1);

      first.path = '/hacked';
      expect(DEFAULT_SETTINGS.library.path).toBe('/audiobooks');
    });
  });
});

// Logger propagation through secret reads surfaces lost or regenerated secret.key failures (#1404).
describe('SettingsService decrypt-failure diagnostic (#1404)', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: SettingsService;

  // Corrupt the auth tag while retaining the registered encrypted-value shape.
  async function corruptBlob(plaintext: string): Promise<string> {
    const { encrypt } = await import('../utils/secret-codec.js');
    const valid = encrypt(plaintext, TEST_KEY);
    const payload = Buffer.from(valid.slice('$ENC$'.length), 'base64');
    payload[13] = payload[13]! ^ 0xff;
    return '$ENC$' + payload.toString('base64');
  }

  // Filters out unrelated parse-fallback warnings.
  function decryptWarn(): Array<[unknown, unknown]> {
    return (log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('secret.key'),
    ) as Array<[unknown, unknown]>;
  }

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    _resetKey();
  });

  it('get("network") warns naming the network entity and proxyUrl when it fails to decrypt', async () => {
    const blob = await corruptBlob('http://user:pass@proxy:8080');
    db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: blob } }]));

    await service.get('network');

    const warns = decryptWarn();
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toEqual({ entity: 'network', failedFields: ['proxyUrl'] });
    // Neither plaintext nor the encrypted blob may leak into diagnostics.
    const serialized = JSON.stringify(warns);
    expect(serialized).not.toContain('proxy:8080');
    expect(serialized).not.toContain('$ENC$');
  });

  it('get("metadata") warns naming the metadata entity and hardcoverApiKey on decrypt failure', async () => {
    const blob = await corruptBlob('sk-secret-7777');
    db.select.mockReturnValue(mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0, hardcoverApiKey: blob } }]));

    await service.get('metadata');

    const warns = decryptWarn();
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toEqual({ entity: 'metadata', failedFields: ['hardcoverApiKey'] });
    expect(JSON.stringify(warns)).not.toContain('sk-secret-7777');
  });

  it('get("network") does not emit the decrypt warn when proxyUrl decrypts cleanly', async () => {
    const { encrypt } = await import('../utils/secret-codec.js');
    const encrypted = encrypt('http://proxy:8080', TEST_KEY);
    db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: encrypted } }]));

    await service.get('network');

    expect(decryptWarn()).toHaveLength(0);
  });

  // getAll has its own decryptFields call, so logger propagation needs separate coverage.
  it('getAll() warns for the network category when its stored proxyUrl fails to decrypt', async () => {
    const blob = await corruptBlob('http://user:pass@proxy:8080');
    db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: blob } }]));

    await service.getAll();

    const warns = decryptWarn();
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toEqual({ entity: 'network', failedFields: ['proxyUrl'] });
    const serialized = JSON.stringify(warns);
    expect(serialized).not.toContain('proxy:8080');
    expect(serialized).not.toContain('$ENC$');
  });
});
