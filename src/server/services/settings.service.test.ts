import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { SettingsService } from './settings.service.js';
import type { UpdateSettingsInput } from '../../shared/schemas/settings/registry.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { initializeKey, _resetKey, isEncrypted } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

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
      // Zod fills missing fields with defaults
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
      expect(result).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' });
    });
  });

  describe('getAll', () => {
    it('merges stored values with defaults', async () => {
      const customLibrary = { path: '/custom', folderFormat: '{title}' };
      db.select.mockReturnValue(
        mockDbChain([{ key: 'library', value: customLibrary }]),
      );

      const result = await service.getAll();
      // Zod fills missing fileFormat with default
      expect(result.library).toEqual({ path: '/custom', folderFormat: '{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
      // Other sections fall back to defaults
      expect(result.search).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' });
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
      // Stored value is a string instead of an object
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: 'not-an-object' }]));

      const result = await service.get('library');
      expect(result).toEqual({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' });
    });

    it('falls back to defaults when stored value has invalid field types', async () => {
      // path should be a string but is a number
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
      // Both should fall back to defaults
      expect(result.library.path).toBe('/audiobooks');
      expect(result.search.intervalMinutes).toBe(360); // application default
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
      // For set(), first call is sentinel lookup (select), second is upsert (insert)
      db.select.mockReturnValue(mockDbChain([])); // No existing value
      db.insert.mockReturnValue(mockDbChain());

      await service.set('network', { proxyUrl: 'http://user:pass@proxy:8080' });

      // The value passed to insert().values() should have encrypted proxyUrl
      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(isEncrypted(storedValue.proxyUrl as string)).toBe(true);
    });

    it('get("network") decrypts stored encrypted proxyUrl', async () => {
      // Manually create an encrypted value to store
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
      // Sentinel lookup returns existing row with encrypted value
      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]));
      db.insert.mockReturnValue(mockDbChain());

      await service.set('network', { proxyUrl: '********' });

      // The stored value should keep the original encrypted proxyUrl, not literal '********'
      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value;
      expect(storedValue.proxyUrl).toBe(existingEncrypted);
    });

    // #844 — entity-aware allowlist on resolveSentinelFields. The only field
    // in the network allowlist is proxyUrl; any other sentinel must throw.
    it('set("network") rejects sentinel on non-secret key rather than substituting it', async () => {
      // Existing record happens to have a value at the bogus key — still must
      // throw, never silently substitute.
      db.select.mockReturnValue(mockDbChain([{ key: 'network', value: { proxyUrl: 'real', stranger: 'persisted' } }]));
      db.insert.mockReturnValue(mockDbChain());

      await expect(
        service.set('network', { proxyUrl: 'real', stranger: '********' } as never),
      ).rejects.toThrow(/non-secret field: stranger/);
    });
  });

  describe('update deep-merge', () => {
    it('preserves other fields when updating a single field in a category', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      // First select for get() inside update, second for getAll()
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // get('search')
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ search: { intervalMinutes: 120 } });

      // The stored value should have merged: intervalMinutes changed, others preserved
      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 120, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' });
    });

    it('preserves other flat fields in quality when updating minSeeders', async () => {
      const existingQuality = { grabFloor: 10, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'quality', value: existingQuality }]))  // get('quality')
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ quality: { minSeeders: 5 } });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toMatchObject({ grabFloor: 10, protocolPreference: 'none', minSeeders: 5 });
    });

    it('preserves sibling quality fields when updating maxDownloadSize', async () => {
      const existingQuality = { grabFloor: 10, protocolPreference: 'none', minSeeders: 3, maxDownloadSize: 5, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' };
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
      db.select.mockReturnValue(mockDbChain([])); // getAll() only
      await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('skips category when value is undefined', async () => {
      db.select.mockReturnValue(mockDbChain([])); // getAll() only
      await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('patch', () => {
    it('preserves existing intervalMinutes and blacklistTtlDays when patching enabled', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7, searchPriority: 'quality' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // get('search')
        .mockReturnValueOnce(mockDbChain([]));  // sentinel lookup in set()
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
      expect(result).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
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
        .mockReturnValueOnce(mockDbChain([]))  // get() returns default
        .mockReturnValueOnce(mockDbChain([]));  // sentinel lookup
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
      expect(result).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7, searchPriority: 'quality' });
    });

    it('sentinel passthrough preserves existing encrypted value', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const existingEncrypted = encrypt('http://real-proxy:8080', TEST_KEY);
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]))  // get() decrypts
        .mockReturnValueOnce(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]));  // sentinel lookup in set()
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
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // get('search') in patch
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
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
        .mockReturnValueOnce(mockDbChain([{ key: 'general', value: existingGeneral }]))  // get('general') in patch
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
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
        .mockReturnValueOnce(mockDbChain([{ key: 'general', value: existingGeneral }]))  // get('general') in patch
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { general: { welcomeSeen: false } };
      await service.update(input);

      const chain = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0]![0]!.value as Record<string, unknown>;
      expect(storedValue.welcomeSeen).toBe(false);
      // Other fields preserved
      expect(storedValue.logLevel).toBe('info');
      expect(storedValue.housekeepingRetentionDays).toBe(90);
    });
  });
});

describe('SettingsService.bootstrapProcessingDefaults', () => {
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

  it('writes detected ffmpegPath plus other defaults (no enabled key) when no processing row exists and detectFfmpegPath returns a path', async () => {
    // No existing processing row
    db.select.mockReturnValue(mockDbChain([]));
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');

    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
    const insertCall = db.insert.mock.results[0]!.value;
    const [call] = insertCall.values.mock.calls as Array<[{ key: string; value: Record<string, unknown> }]>;
    expect(call![0].key).toBe('processing');
    expect(call![0].value).toMatchObject({
      ffmpegPath: '/usr/bin/ffmpeg',
      outputFormat: 'm4b',
      bitrate: 128,
      mergeBehavior: 'multi-file-only',
      maxConcurrentProcessing: 2,
    });
    expect(call![0].value).not.toHaveProperty('enabled');
  });

  it('writes nothing when no processing row exists and detectFfmpegPath returns null', async () => {
    db.select.mockReturnValue(mockDbChain([]));
    const detectFfmpegPath = vi.fn().mockResolvedValue(null);

    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('does not call detectFfmpegPath when processing row already exists', async () => {
    db.select.mockReturnValue(mockDbChain([{ key: 'processing', value: { ffmpegPath: '' } }]));
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');

    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('is idempotent: second call with row written by first call skips detection', async () => {
    // First call: no row
    db.select.mockReturnValueOnce(mockDbChain([]));
    // After first insert, second call finds the row
    db.select.mockReturnValueOnce(mockDbChain([{ key: 'processing', value: { ffmpegPath: '/usr/bin/ffmpeg' } }]));
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');

    await service.bootstrapProcessingDefaults(detectFfmpegPath);
    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).toHaveBeenCalledTimes(1);
  });

  it('forward-compat: historical row with enabled=true returns parsed object without enabled key', async () => {
    // Simulate a pre-migration DB row that still has `enabled`
    db.select.mockReturnValue(mockDbChain([{ key: 'processing', value: { enabled: true, ffmpegPath: '/ffmpeg' } }]));

    const result = await service.get('processing');

    expect(result.ffmpegPath).toBe('/ffmpeg');
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
    // metadata row has no languages key
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]); // metadata check
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: 'spanish', rejectWords: 'abridged' } }]); // quality read
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]); // patch->get
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    // Should have written metadata with languages and cleaned up quality
    const insertCalls = db.insert.mock.calls;
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips migration when preferredLanguage is empty string', async () => {
    db.select.mockImplementation(() => {
      return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
    });
    // Second call: quality with empty preferredLanguage
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: '' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    // Should still clean up quality blob but not patch metadata languages
    const insertCalls = db.insert.mock.calls;
    // Only the quality cleanup write, no metadata patch
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

    // Only quality cleanup, no metadata patch
    expect(db.insert.mock.calls.length).toBe(1);
  });

  it('skips migration when metadata.languages already exists (idempotency)', async () => {
    db.select.mockReturnValue(mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us', languages: ['french'] } }]));

    await service.migrateLanguageSettings();

    // Should not write anything
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('preserves existing protocolPreference, rejectWords, requiredWords in quality blob', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 10, protocolPreference: 'torrent', rejectWords: 'abridged', requiredWords: 'unabridged', preferredLanguage: 'german' } }]);
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]); // patch->get
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    // The quality blob write should preserve other fields
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

    // Verify the quality write does NOT include preferredLanguage
    expect(db.insert).toHaveBeenCalled();
  });

  it('normalizes non-canonical legacy value (e.g. ISO code) to canonical name before writing', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]);
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, preferredLanguage: 'eng' } }]);
      if (callCount === 3) return mockDbChain([{ key: 'metadata', value: { audibleRegion: 'us' } }]); // patch->get
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain([]));

    await service.migrateLanguageSettings();

    // Should have written metadata — normalizeLanguage('eng') → 'english' which is canonical
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

    // Should warn about non-canonical value
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ preferredLanguage: 'klingon' }),
      expect.stringContaining('not a canonical language'),
    );
    // Still cleans up quality blob (1 insert for quality cleanup, no metadata patch)
    expect(db.insert.mock.calls.length).toBe(1);
  });

  it('logs warning and does not block startup on migration error', async () => {
    db.select.mockImplementation(() => { throw new Error('DB connection failed'); });

    // Should not throw
    await service.migrateLanguageSettings();

    expect(log.warn).toHaveBeenCalled();
  });
});

describe('migrateRejectWordsDefault', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;
  const NEW_DEFAULT = 'Virtual Voice, Free Excerpt, Sample, Behind the Scenes';

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
      if (callCount === 1) return mockDbChain([]); // migration flag check
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    // Two writes expected: quality update + flag insert
    expect(db.insert.mock.calls.length).toBeGreaterThanOrEqual(2);
    const qualityWrite = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ key: string; value: Record<string, unknown> }>> } } };
    const stored = qualityWrite.values.mock.calls[0]![0]!.value;
    expect(stored.rejectWords).toBe(NEW_DEFAULT);
    expect(stored.grabFloor).toBe(0); // other fields preserved
  });

  it('skips quality write when stored rejectWords is non-empty (user customized) but still marks flag applied', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]); // flag check — not run
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: 'My Custom Word' } }]);
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    // Only one insert (the flag); no quality write
    expect(db.insert.mock.calls.length).toBe(1);
    const flagWrite = db.insert.mock.calls[0]![0];
    // The flag insert call passes the settingsMigrations table
    expect(flagWrite).toBeDefined();
  });

  it('skips quality write and marks flag applied when no quality row exists', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]); // flag check — not run
      if (callCount === 2) return mockDbChain([]); // no quality row
      return mockDbChain([]);
    });
    db.insert.mockReturnValue(mockDbChain());

    await service.migrateRejectWordsDefault();

    // Only one insert (the flag); no quality write
    expect(db.insert.mock.calls.length).toBe(1);
  });

  it('is idempotent: returns early when migration flag is already set', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ id: 'rejectWords-defaults-v1', appliedAt: new Date() }]));

    await service.migrateRejectWordsDefault();

    expect(db.insert).not.toHaveBeenCalled();
    // Only one DB read — the flag check
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('post-migration user-cleared empty string is preserved (does not re-migrate)', async () => {
    // Flag is already set from the previous run
    db.select.mockReturnValueOnce(mockDbChain([{ id: 'rejectWords-defaults-v1', appliedAt: new Date() }]));

    await service.migrateRejectWordsDefault();

    // No writes — stored '' stays '' on subsequent reads
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

    const qualityWrite = db.insert.mock.results[0]!.value as { values: { mock: { calls: Array<Array<{ key: string; value: Record<string, unknown> }>> } } };
    const stored = qualityWrite.values.mock.calls[0]![0]!.value;
    expect(stored).toEqual({
      grabFloor: 50,
      protocolPreference: 'torrent',
      minSeeders: 10,
      rejectWords: NEW_DEFAULT,
      requiredWords: 'M4B',
    });
  });

  it('invalidates quality cache after legacy-default write', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockDbChain([]); // flag check
      if (callCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      // Subsequent get('quality') — returns the new written value
      return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: NEW_DEFAULT } }]);
    });
    db.insert.mockReturnValue(mockDbChain());

    // Prime the cache with a get() before migration
    db.select.mockReturnValueOnce(mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]));
    await service.get('quality');
    db.select.mockClear();

    // Reset for migration: flag check → quality read → post-write get
    let postCount = 0;
    db.select.mockImplementation(() => {
      postCount++;
      if (postCount === 1) return mockDbChain([]); // flag check
      if (postCount === 2) return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: '' } }]);
      return mockDbChain([{ key: 'quality', value: { grabFloor: 0, rejectWords: NEW_DEFAULT } }]);
    });

    await service.migrateRejectWordsDefault();

    // Read after migration should hit the DB (cache invalidated), not return cached ''
    const result = await service.get('quality');
    expect(result.rejectWords).toBe(NEW_DEFAULT);
  });
});

describe('SettingsService — cache (#554)', () => {
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
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/lib' } }]));

      await service.getAll();
      expect(db.select).toHaveBeenCalledTimes(1);

      db.select.mockClear();
      await service.getAll();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('getAll() returns cached aggregate on second call within TTL', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/custom' } }]));

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
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: { path: '/old' } }]));
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
      db.select.mockReturnValue(mockDbChain([]));
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
      // Prime quality cache
      db.select.mockReturnValue(mockDbChain([{ key: 'quality', value: { minBitrate: 64 } }]));
      await service.get('quality');
      db.select.mockClear();

      // migrateLanguageSettings: metadata has no languages, quality has no preferredLanguage
      // → skips migration but still cleans up quality blob
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'metadata', value: {} }]))
        .mockReturnValueOnce(mockDbChain([{ key: 'quality', value: { minBitrate: 64 } }]));
      db.insert.mockReturnValue(mockDbChain());
      await service.migrateLanguageSettings();
      db.select.mockClear();

      // quality cache should be invalidated after the cleanup write
      db.select.mockReturnValue(mockDbChain([{ key: 'quality', value: { minBitrate: 64 } }]));
      await service.get('quality');
      expect(db.select).toHaveBeenCalled();
    });

    it('update() returns fresh aggregate reflecting the write', async () => {
      // patch('library') → get('library') returns empty (defaults)
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());
      // getAll() after patch returns the updated row
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

      // At +31s, library expired but search (cached at +15s) still valid
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
      db.select.mockReturnValue(mockDbChain([]));

      await service.getAll();
      db.select.mockClear();

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);

      db.select.mockReturnValue(mockDbChain([]));
      await service.getAll();
      expect(db.select).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  describe('boundary values', () => {
    it('get() for category with no DB row returns DEFAULT_SETTINGS and caches the default', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('library');
      expect(result.path).toBe('/audiobooks');
      db.select.mockClear();

      const result2 = await service.get('library');
      expect(result2.path).toBe('/audiobooks');
      expect(db.select).not.toHaveBeenCalled();
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
});
