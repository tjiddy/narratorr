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
      expect(result).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 });
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
      expect(result.search).toEqual({ intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 });
      expect(result.import).toEqual({ deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5, redownloadFailed: true });
      expect(result.general).toEqual({ logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30, welcomeSeen: false });
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

      await service.set('library', { path: '/new', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });

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
      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value;
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
      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value;
      expect(storedValue.proxyUrl).toBe(existingEncrypted);
    });
  });

  describe('update deep-merge', () => {
    it('preserves other fields when updating a single field in a category', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 };
      // First select for get() inside update, second for getAll()
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // get('search')
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ search: { intervalMinutes: 120 } });

      // The stored value should have merged: intervalMinutes changed, others preserved
      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 120, enabled: true, blacklistTtlDays: 7 });
    });

    it('preserves other flat fields in quality when updating minSeeders', async () => {
      const existingQuality = { grabFloor: 10, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'quality', value: existingQuality }]))  // get('quality')
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ quality: { minSeeders: 5 } });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toMatchObject({ grabFloor: 10, protocolPreference: 'none', minSeeders: 5 });
    });

    it('works with a full category object (backward compat)', async () => {
      const full = { intervalMinutes: 120, enabled: false, blacklistTtlDays: 14 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 } }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      await service.update({ search: full });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual(full);
    });

    it('results in no changes for empty partial object', async () => {
      db.select.mockReturnValue(mockDbChain([])); // getAll() only
      await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('skips category when value is undefined', async () => {
      db.select.mockReturnValue(mockDbChain([])); // getAll() only
      await service.update({ search: undefined });

      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('patch', () => {
    it('preserves existing intervalMinutes and blacklistTtlDays when patching enabled', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // get('search')
        .mockReturnValueOnce(mockDbChain([]));  // sentinel lookup in set()
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7 });
      expect(result).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7 });
    });

    it('preserves existing deleteAfterImport and minSeedTime when patching minFreeSpaceGB', async () => {
      const existingImport = { deleteAfterImport: true, minSeedTime: 120, minFreeSpaceGB: 5, redownloadFailed: true };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'import', value: existingImport }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('import', { minFreeSpaceGB: 10 });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual({ deleteAfterImport: true, minSeedTime: 120, minFreeSpaceGB: 10, redownloadFailed: true });
      expect(result).toEqual({ deleteAfterImport: true, minSeedTime: 120, minFreeSpaceGB: 10, redownloadFailed: true });
    });

    it('stores falsy value 0, not the default', async () => {
      const existingImport = { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'import', value: existingImport }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('import', { minFreeSpaceGB: 0 });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue.minFreeSpaceGB).toBe(0);
      expect(result.minFreeSpaceGB).toBe(0);
    });

    it('stores falsy value false, not the default', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.patch('search', { enabled: false });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue.enabled).toBe(false);
      expect(result.enabled).toBe(false);
    });

    it('empty partial is a no-op — returns existing values unchanged without DB write', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 };
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

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7 });
      expect(result).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7 });
    });

    it('sentinel passthrough preserves existing encrypted value', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const existingEncrypted = encrypt('http://real-proxy:8080', TEST_KEY);
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]))  // get() decrypts
        .mockReturnValueOnce(mockDbChain([{ key: 'network', value: { proxyUrl: existingEncrypted } }]));  // sentinel lookup in set()
      db.insert.mockReturnValue(mockDbChain());

      await service.patch('network', { proxyUrl: '********' });

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: Record<string, unknown> }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value;
      expect(storedValue.proxyUrl).toBe(existingEncrypted);
    });
  });

  describe('update with UpdateSettingsInput', () => {
    it('accepts partial category values via UpdateSettingsInput', async () => {
      const existingSearch = { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'search', value: existingSearch }]))  // get('search') in patch
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { search: { enabled: false } };
      await service.update(input);

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual({ intervalMinutes: 360, enabled: false, blacklistTtlDays: 7 });
    });

    it('returns all settings without DB writes for empty input', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.update({});

      expect(db.insert).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('preserves welcomeSeen when patching logLevel in general category', async () => {
      const existingGeneral = { logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30, welcomeSeen: true };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'general', value: existingGeneral }]))  // get('general') in patch
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { general: { logLevel: 'debug' } };
      await service.update(input);

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
      expect(storedValue).toEqual({ logLevel: 'debug', housekeepingRetentionDays: 90, recycleRetentionDays: 30, welcomeSeen: true });
    });

    it('stores welcomeSeen: false when only welcomeSeen is patched', async () => {
      const existingGeneral = { logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30, welcomeSeen: true };
      db.select
        .mockReturnValueOnce(mockDbChain([{ key: 'general', value: existingGeneral }]))  // get('general') in patch
        .mockReturnValueOnce(mockDbChain([]))  // sentinel lookup in set()
        .mockReturnValueOnce(mockDbChain([])); // getAll()
      db.insert.mockReturnValue(mockDbChain());

      const input: UpdateSettingsInput = { general: { welcomeSeen: false } };
      await service.update(input);

      const chain = db.insert.mock.results[0].value as { values: { mock: { calls: Array<Array<{ value: unknown }>> } } };
      const storedValue = chain.values.mock.calls[0][0].value as Record<string, unknown>;
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

  it('writes processing.enabled=false and detected ffmpegPath when no processing row exists and detectFfmpegPath returns a path', async () => {
    // No existing processing row
    db.select.mockReturnValue(mockDbChain([]));
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');

    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
    const insertCall = db.insert.mock.results[0].value;
    expect(insertCall.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'processing',
        value: expect.objectContaining({ enabled: false, ffmpegPath: '/usr/bin/ffmpeg' }),
      }),
    );
  });

  it('writes nothing when no processing row exists and detectFfmpegPath returns null', async () => {
    db.select.mockReturnValue(mockDbChain([]));
    const detectFfmpegPath = vi.fn().mockResolvedValue(null);

    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('does not call detectFfmpegPath when processing row already exists', async () => {
    db.select.mockReturnValue(mockDbChain([{ key: 'processing', value: { enabled: false, ffmpegPath: '' } }]));
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');

    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('is idempotent: second call with row written by first call skips detection', async () => {
    // First call: no row
    db.select.mockReturnValueOnce(mockDbChain([]));
    // After first insert, second call finds the row
    db.select.mockReturnValueOnce(mockDbChain([{ key: 'processing', value: { enabled: false, ffmpegPath: '/usr/bin/ffmpeg' } }]));
    const detectFfmpegPath = vi.fn().mockResolvedValue('/usr/bin/ffmpeg');

    await service.bootstrapProcessingDefaults(detectFfmpegPath);
    await service.bootstrapProcessingDefaults(detectFfmpegPath);

    expect(detectFfmpegPath).toHaveBeenCalledTimes(1);
  });
});
