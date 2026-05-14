import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { ImportListService } from './import-list.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import { initializeKey, _resetKey, encrypt, getKey } from '../utils/secret-codec.js';
import { randomBytes } from 'node:crypto';
import { mockDbChain, createMockDb, createMockLogger, inject } from '../__tests__/helpers.js';
import type { ImmediateSearchDeps } from '../routes/trigger-immediate-search.js';

// Mock the adapter factories
vi.mock('../../core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: {
    abs: vi.fn(),
    nyt: vi.fn(),
    hardcover: vi.fn(),
  },
}));

// Stub the trigger so search-pipeline isn't actually invoked from these unit tests
vi.mock('../routes/trigger-immediate-search.js', () => ({
  triggerImmediateSearch: vi.fn(),
}));

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('../../core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as Record<string, ReturnType<typeof vi.fn>>;
const { triggerImmediateSearch } = await import('../routes/trigger-immediate-search.js');
const mockTriggerImmediateSearch = triggerImmediateSearch as unknown as ReturnType<typeof vi.fn>;

const mockLog = createMockLogger() as unknown as FastifyBaseLogger;

/**
 * Build a stub BookService whose `findDuplicate` and `create` are vi.fn()s.
 * Default: no duplicates, create returns a BookWithAuthor-like row with the
 * supplied id/title.
 */
function makeBookService(overrides: {
  findDuplicate?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
} = {}): BookService {
  const findDuplicate = overrides.findDuplicate ?? vi.fn().mockResolvedValue(null);
  const create = overrides.create ?? vi.fn().mockImplementation(async (data: { title: string }): Promise<BookWithAuthor> => ({
    id: 100,
    title: data.title,
    description: null,
    coverUrl: null,
    goodreadsId: null,
    audibleId: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    status: 'wanted',
    enrichmentStatus: 'pending',
    path: null,
    size: null,
    audioCodec: null,
    audioBitrate: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitrateMode: null,
    audioFileFormat: null,
    audioFileCount: null,
    topLevelAudioFileCount: null,
    audioTotalSize: null,
    audioDuration: null,
    lastGrabGuid: null,
    lastGrabInfoHash: null,
    importListId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    authors: [],
    narrators: [],
    importListName: null,
  }));
  return inject<BookService>({ findDuplicate, create });
}

describe('ImportListService', () => {
  let service: ImportListService;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    initializeKey(randomBytes(32));
  });

  describe('testConfig', () => {
    it('calls provider test with provided config', async () => {
      const mockProvider = { test: vi.fn().mockResolvedValue({ success: true }), fetchItems: vi.fn() };
      mockFactories.abs!.mockReturnValue(mockProvider);

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.testConfig({
        type: 'abs',
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
      });
      expect(result).toEqual({ success: true });
      expect(mockFactories.abs).toHaveBeenCalledWith({ serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' });
    });

    it('returns failure for unknown provider type', async () => {
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.testConfig({ type: 'unknown', settings: {} });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown provider type');
    });

    it('catches provider test errors', async () => {
      mockFactories.nyt!.mockImplementation(() => { throw new Error('Bad config'); });
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.testConfig({ type: 'nyt', settings: { apiKey: 'key' } });
      expect(result.success).toBe(false);
      expect(result.message).toBe('Bad config');
    });

    describe('sentinel resolution (#827)', () => {
      it('with id, replaces sentinel apiKey with saved (decrypted) value before factory call', async () => {
        const mockProvider = { test: vi.fn().mockResolvedValue({ success: true }), fetchItems: vi.fn() };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const encryptedApiKey = encrypt('real-api-key', getKey());
        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([{
          id: 1, name: 'Existing', type: 'abs', enabled: true,
          settings: { serverUrl: 'http://abs.local', apiKey: encryptedApiKey, libraryId: 'lib-1' },
          syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: null,
          lastSyncError: null, createdAt: new Date(),
        }]));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        const result = await service.testConfig({
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
          id: 1,
        });

        expect(result).toEqual({ success: true });
        expect(mockFactories.abs).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: 'real-api-key' }),
        );
      });

      it('without id, passes sentinel literally to provider (no resolution)', async () => {
        const mockProvider = { test: vi.fn().mockResolvedValue({ success: false }), fetchItems: vi.fn() };
        mockFactories.abs!.mockReturnValue(mockProvider);
        const db = createMockDb();
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        await service.testConfig({
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
        });

        expect(mockFactories.abs).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: '********' }),
        );
      });

      it('with id for missing row returns Import list not found and skips provider factory', async () => {
        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([]));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        const result = await service.testConfig({
          type: 'abs',
          settings: { serverUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' },
          id: 999,
        });

        expect(result).toEqual({ success: false, message: 'Import list not found' });
        expect(mockFactories.abs).not.toHaveBeenCalled();
      });
    });
  });

  // #732 — Saved-row validation + Hardcover shelfId numeric tightening
  describe('Hardcover shelfId saved-row parsing (#732)', () => {
    function makeHardcoverList(settings: Record<string, unknown>) {
      return {
        id: 1, name: 'My Shelf', type: 'hardcover', enabled: true,
        settings,
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
    }

    it('test(id) coerces saved numeric-string shelfId and constructs provider with number', async () => {
      const mockProvider = { test: vi.fn().mockResolvedValue({ success: true }), fetchItems: vi.fn() };
      mockFactories.hardcover!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([makeHardcoverList({ apiKey: 'k', listType: 'shelf', shelfId: '42' })]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.test(1);
      expect(result.success).toBe(true);
      expect(mockFactories.hardcover).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'k', listType: 'shelf', shelfId: 42 }),
      );
    });

    it('test(id) rejects saved row with non-numeric shelfId without invoking provider factory', async () => {
      mockFactories.hardcover!.mockClear();
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([makeHardcoverList({ apiKey: 'k', listType: 'shelf', shelfId: 'junk' })]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.test(1);
      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
      expect(mockFactories.hardcover).not.toHaveBeenCalled();
    });

    it('legacy default compatibility: trending row with shelfId === "" parses successfully', async () => {
      const mockProvider = { test: vi.fn().mockResolvedValue({ success: true }), fetchItems: vi.fn().mockResolvedValue([]) };
      mockFactories.hardcover!.mockReturnValue(mockProvider);

      const db = createMockDb();
      const legacyRow = makeHardcoverList({ apiKey: 'k', listType: 'trending', shelfId: '' });
      db.select.mockReturnValue(mockDbChain([legacyRow]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const testResult = await service.test(1);
      expect(testResult.success).toBe(true);
      const factoryArg = mockFactories.hardcover!.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(factoryArg).toEqual({ apiKey: 'k', listType: 'trending' });

      await service.syncDueLists();
      const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(setCall?.lastSyncError).toBeNull();
    });

    it('syncDueLists records lastSyncError when saved shelfId fails validation', async () => {
      mockFactories.hardcover!.mockClear();
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([makeHardcoverList({ apiKey: 'k', listType: 'shelf', shelfId: '1 } }' })]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());
      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(setCall?.lastSyncError).toBeTruthy();
      expect(mockFactories.hardcover).not.toHaveBeenCalled();
    });

    it('preview rejects invalid Hardcover shelfId without invoking provider factory (AC6)', async () => {
      mockFactories.hardcover!.mockClear();
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await expect(
        service.preview({ type: 'hardcover', settings: { apiKey: 'k', listType: 'shelf', shelfId: 'junk' } }),
      ).rejects.toThrow();
      expect(mockFactories.hardcover).not.toHaveBeenCalled();
    });
  });

  // #786 — ABS libraryId URL-path injection tightening
  describe('ABS libraryId saved-row parsing (#786)', () => {
    function makeAbsList(settings: Record<string, unknown>) {
      return {
        id: 1, name: 'My ABS', type: 'abs', enabled: true,
        settings,
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
    }

    it('test(id) rejects saved row with path-injection libraryId without invoking provider factory', async () => {
      mockFactories.abs!.mockClear();
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([makeAbsList({ serverUrl: 'http://abs.local', apiKey: 'k', libraryId: 'lib/../x' })]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.test(1);
      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
      expect(mockFactories.abs).not.toHaveBeenCalled();
    });

    it('syncDueLists records lastSyncError when saved libraryId fails validation', async () => {
      mockFactories.abs!.mockClear();
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([makeAbsList({ serverUrl: 'http://abs.local', apiKey: 'k', libraryId: 'lib/../x' })]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());
      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(setCall?.lastSyncError).toBeTruthy();
      expect(mockFactories.abs).not.toHaveBeenCalled();
    });

    it('preview rejects invalid ABS libraryId without invoking provider factory', async () => {
      mockFactories.abs!.mockClear();
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await expect(
        service.preview({ type: 'abs', settings: { serverUrl: 'http://abs.local', apiKey: 'k', libraryId: 'lib/../x' } }),
      ).rejects.toThrow();
      expect(mockFactories.abs).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('returns first 10 items capped with total count', async () => {
      const items = Array.from({ length: 15 }, (_, i) => ({ title: `Book ${i}` }));
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue(items), test: vi.fn() };
      mockFactories.nyt!.mockReturnValue(mockProvider);

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.preview({ type: 'nyt', settings: { apiKey: 'key', list: 'audio-fiction' } });
      expect(result.items).toHaveLength(10);
      expect(result.total).toBe(15);
    });

    it('returns empty items array when provider returns nothing', async () => {
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.hardcover!.mockReturnValue(mockProvider);

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.preview({ type: 'hardcover', settings: { apiKey: 'key' } });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('throws for unknown provider type', async () => {
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await expect(service.preview({ type: 'unknown', settings: {} })).rejects.toThrow('Unknown provider type');
    });
  });

  describe('CRUD', () => {
    it('getAll returns all import lists', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 1, name: 'Test', type: 'abs', settings: {}, enabled: true }]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const results = await service.getAll();
      expect(results).toHaveLength(1);
      expect(db.select).toHaveBeenCalled();
    });

    it('create encrypts API key and sets nextRunAt', async () => {
      const db = createMockDb();
      const insertChain = mockDbChain([{ id: 1, name: 'Test', type: 'abs', settings: { serverUrl: 'http://abs.local', apiKey: 'key' }, createdAt: new Date() }]);
      db.insert.mockReturnValue(insertChain);
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.create({
        name: 'Test',
        type: 'abs',
        enabled: true,
        syncIntervalMinutes: 1440,
        settings: { serverUrl: 'http://abs.local', apiKey: 'test-key', libraryId: 'lib-1' },
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ nextRunAt: expect.any(Date) }),
      );
    });

    it('update preserves existing encrypted API key when sentinel is submitted', async () => {
      const db = createMockDb();
      const encryptedApiKey = encrypt('real-api-key', getKey());
      const existingRow = {
        id: 1, name: 'Test', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://old.local', apiKey: encryptedApiKey, libraryId: 'lib-1' },
      };

      db.select.mockReturnValue(mockDbChain([existingRow]));
      const updateChain = mockDbChain([existingRow]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await service.update(1, {
        settings: { serverUrl: 'http://new.local', apiKey: '********', libraryId: 'lib-2' },
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            apiKey: encryptedApiKey,
            libraryId: 'lib-2',
          }),
        }),
      );
    });

    // #844 — entity-aware allowlist on resolveSentinelFields
    it('update rejects sentinel on a non-secret field rather than silently substituting it', async () => {
      const db = createMockDb();
      const existingRow = {
        id: 1, name: 'Test', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://persisted.local', apiKey: 'real', libraryId: 'lib-1' },
      };
      db.select.mockReturnValue(mockDbChain([existingRow]));
      db.update.mockReturnValue(mockDbChain([existingRow]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await expect(
        service.update(1, {
          settings: { serverUrl: '********', apiKey: 'still-real', libraryId: 'lib-1' },
        }),
      ).rejects.toThrow(/non-secret field: serverUrl/);
    });

    it('delete removes row from DB', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 1, name: 'Test', type: 'abs', settings: {}, enabled: true }]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('syncDueLists', () => {
    const dueAbsList = (overrides: Record<string, unknown> = {}) => ({
      id: 1, name: 'My ABS', type: 'abs', enabled: true,
      settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
      syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
      lastSyncError: null, createdAt: new Date(),
      ...overrides,
    });

    /**
     * Build a `BookWithAuthor`-shaped row that the bookService.create stub returns.
     * Tests assert against this shape's id/title — other fields just satisfy types.
     */
    const createdBook = (id: number, title: string): BookWithAuthor => ({
      id, title,
      description: null, coverUrl: null, goodreadsId: null, audibleId: null,
      asin: null, isbn: null, seriesName: null, seriesPosition: null,
      duration: null, publishedDate: null, genres: null,
      status: 'wanted', enrichmentStatus: 'pending',
      path: null, size: null,
      audioCodec: null, audioBitrate: null, audioSampleRate: null,
      audioChannels: null, audioBitrateMode: null, audioFileFormat: null,
      audioFileCount: null, topLevelAudioFileCount: null, audioTotalSize: null,
      audioDuration: null, lastGrabGuid: null, lastGrabInfoHash: null,
      importListId: null, createdAt: new Date(), updatedAt: new Date(),
      authors: [], narrators: [], importListName: null,
    });

    it('skips disabled lists even if nextRunAt is past due', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await service.syncDueLists();
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ count: expect.any(Number) }),
        expect.stringContaining('Processing'),
      );
    });

    it('routes a successful, non-duplicate item through BookService.create + writes import_list event + logs', async () => {
      const mockProvider = {
        fetchItems: vi.fn().mockResolvedValue([{ title: 'New Book', author: 'Author Name' }]),
        test: vi.fn(),
      };
      mockFactories.abs!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueAbsList({ id: 7, name: 'My List' })]));
      const eventInsertChain = mockDbChain([]);
      db.insert.mockReturnValue(eventInsertChain);
      db.update.mockReturnValue(mockDbChain([]));

      const create = vi.fn().mockResolvedValue(createdBook(42, 'New Book'));
      const findDuplicate = vi.fn().mockResolvedValue(null);
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }));

      await service.syncDueLists();

      expect(findDuplicate).toHaveBeenCalledWith('New Book', [{ name: 'Author Name' }], undefined);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'New Book',
        authors: [{ name: 'Author Name' }],
        status: 'wanted',
        importListId: 7,
      }));
      expect(eventInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, eventType: 'grabbed', source: 'import_list', authorName: 'Author Name' }),
      );
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, title: 'New Book', listName: 'My List' }),
        expect.stringContaining('Book added from import list'),
      );
    });

    it('skips items with empty title and continues processing', async () => {
      const mockProvider = {
        fetchItems: vi.fn().mockResolvedValue([
          { title: '', author: 'Nobody' },
          { title: 'Valid Book', author: 'Author' },
        ]),
        test: vi.fn(),
      };
      mockFactories.abs!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueAbsList({ name: 'Mixed List' })]));
      db.insert.mockReturnValue(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain([]));

      const create = vi.fn().mockResolvedValue(createdBook(20, 'Valid Book'));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }));

      await service.syncDueLists();

      const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const emptyTitleWarn = warnCalls.find((call) => {
        const msg = call[1] as string;
        return typeof msg === 'string' && msg.includes('empty/null title');
      });
      expect(emptyTitleWarn).toBeDefined();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Valid Book' }));
    });

    it('persists lastRunAt, nextRunAt, clears lastSyncError on success', async () => {
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.abs!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueAbsList({ id: 5, syncIntervalMinutes: 60, lastSyncError: 'old error' })]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toBeNull();
      expect(setCall.lastRunAt).toBeInstanceOf(Date);
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
      const diff = (setCall.nextRunAt as Date).getTime() - Date.now();
      expect(diff).toBeGreaterThan(59 * 60_000);
      expect(diff).toBeLessThan(61 * 60_000);
    });

    it('persists lastSyncError and advances nextRunAt on failure', async () => {
      const failProvider = { fetchItems: vi.fn().mockRejectedValue(new Error('Connection timeout')), test: vi.fn() };
      mockFactories.abs!.mockReturnValue(failProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueAbsList({ id: 3, name: 'Failing List' })]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toBe('Connection timeout');
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
    });

    // F1 — dedup pre-flight + no audit row + no immediate search on duplicate
    describe('dedup', () => {
      it('skips create when findDuplicate returns a match — no event, no immediate search, debug log', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Already Have', author: 'Someone', asin: 'B_DUP' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        const eventInsertChain = mockDbChain([]);
        db.insert.mockReturnValue(eventInsertChain);
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({ id: 999, title: 'Already Have' });
        const create = vi.fn();
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue(null),
          search: vi.fn(),
        } as unknown as MetadataService;
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }), mockMetadata, searchDeps,
        );

        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith('Already Have', [{ name: 'Someone' }], 'B_DUP');
        expect(create).not.toHaveBeenCalled();
        // No event row written
        expect(eventInsertChain.values).not.toHaveBeenCalledWith(
          expect.objectContaining({ source: 'import_list' }),
        );
        expect(mockTriggerImmediateSearch).not.toHaveBeenCalled();
        expect(mockLog.debug).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Already Have' }),
          expect.stringContaining('Book already exists, skipped'),
        );
      });

      it('authorless dedup: passes authorList: undefined to findDuplicate (NOT [{ name: undefined }])', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Anonymous Book' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue(null);
        const create = vi.fn().mockResolvedValue(createdBook(11, 'Anonymous Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }));

        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith('Anonymous Book', undefined, undefined);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Anonymous Book', authors: [] }));
      });
    });

    // F4 — author failure semantics: rollback inside BookService.create propagates;
    // catch in syncList logs warn; no event row, no immediate search.
    describe('author failure semantics (F4)', () => {
      it('BookService.create throws — no event row, no immediate search, warn logged, sync continues', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Bad Item', author: 'Ghost Author' },
            { title: 'Good Item', author: 'Real Author' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        const eventInsertChain = mockDbChain([]);
        db.insert.mockReturnValue(eventInsertChain);
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn()
          .mockRejectedValueOnce(new Error('Failed to find or create author: Ghost Author'))
          .mockResolvedValueOnce(createdBook(20, 'Good Item'));
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined, searchDeps,
        );

        await service.syncDueLists();

        // Bad Item: no event row insert and no immediate search
        const eventValuesCalls = eventInsertChain.values.mock.calls as unknown[][];
        const badItemEvent = eventValuesCalls.find((call) => {
          const v = call[0] as { bookTitle?: string };
          return v.bookTitle === 'Bad Item';
        });
        expect(badItemEvent).toBeUndefined();

        // Good Item went through
        expect(create).toHaveBeenCalledTimes(2);
        const goodEvent = eventValuesCalls.find((call) => {
          const v = call[0] as { bookTitle?: string };
          return v.bookTitle === 'Good Item';
        });
        expect(goodEvent).toBeDefined();

        // Bad Item's failure was warn-logged via syncList's per-item try/catch
        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const failWarn = warnCalls.find((call) => {
          const ctx = call[0] as { title?: string };
          const msg = call[1] as string;
          return ctx.title === 'Bad Item' && typeof msg === 'string' && msg.includes('Failed to process');
        });
        expect(failWarn).toBeDefined();

        // Immediate search fires only for Good Item
        await vi.waitFor(() => expect(mockTriggerImmediateSearch).toHaveBeenCalledTimes(1));
        const [bookArg] = mockTriggerImmediateSearch.mock.calls[0]!;
        expect(bookArg).toEqual(expect.objectContaining({ id: 20, title: 'Good Item' }));
      });
    });

    // F12 + §3/§4 — enrichItem behavior: ASIN-identity vs search-candidate paths
    describe('enrichItem paths', () => {
      it('no metadata service — book inserted with item-supplied fields, no search/enrichBook calls', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'My Book', author: 'Original Author', asin: 'B001', coverUrl: 'http://nyt.com/cover.jpg', description: 'desc' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'My Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }));
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'My Book', asin: 'B001', authors: [{ name: 'Original Author' }],
          coverUrl: 'http://nyt.com/cover.jpg', description: 'desc',
        }));
      });

      // #1119 — ASIN-bearing items now get rich metadata from enrichBook, and the
      // metadata's title/author win over the raw provider fields (ASIN is identity).
      it('item has ASIN → enrichBook called, NOT search; metadata identity + side fields flow to BookService.create', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B002', title: 'Different Title From Audnexus', authors: [{ name: 'Audnexus Author' }],
            narrators: ['Narrator A', 'Narrator B'],
            seriesPrimary: { name: 'Real Series', position: 3, asin: 'SER1' },
            series: [{ name: 'Broader Universe', position: 99, asin: 'UNI1' }],
            duration: 36000, publishedDate: '2020-01-01', genres: ['Fantasy'],
            description: 'rich description', coverUrl: 'http://audnexus/cover.jpg',
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Item Title', author: 'Item Author', asin: 'B002' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Different Title From Audnexus'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(mockMetadata.enrichBook).toHaveBeenCalledWith('B002');
        expect(mockMetadata.search).not.toHaveBeenCalled();

        // Metadata identity wins for title + authors; cover/description still
        // accept the raw item value as a hint (item.* ?? match.*); rich
        // match-only fields flow through. seriesPrimary wins over series[0].
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Different Title From Audnexus',
          authors: [{ name: 'Audnexus Author' }],
          asin: 'B002',
          narrators: ['Narrator A', 'Narrator B'],
          seriesName: 'Real Series',
          seriesPosition: 3,
          seriesAsin: 'SER1',
          duration: 36000,
          publishedDate: '2020-01-01',
          genres: ['Fantasy'],
        }));
      });

      // #1119 AC test #1 — ASIN-identity: metadata author + title win at the
      // create payload (replaces the prior `ASIN-identity path skips §4 fuzzy
      // validation` test that blessed the chimera behavior).
      it('ASIN-identity: metadata author + title win at create + findDuplicate', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
            narrators: ['Tim Gerard Reynolds'], duration: 64000,
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'Navessa Allen', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Golden Son'));
        const findDuplicate = vi.fn().mockResolvedValue(null);
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), mockMetadata,
        );
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith('Golden Son', [{ name: 'Pierce Brown' }], 'B00R6S1RCY');
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Golden Son',
          authors: [{ name: 'Pierce Brown' }],
          narrators: ['Tim Gerard Reynolds'],
          duration: 64000,
        }));
      });

      // #1119 AC test #2 — ASIN-identity: metadata title wins when item title differs
      it('ASIN-identity: metadata title wins when item title differs', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'golden son (unabridged)', author: 'Pierce Brown', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Golden Son'));
        const findDuplicate = vi.fn().mockResolvedValue(null);
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), mockMetadata,
        );
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith('Golden Son', [{ name: 'Pierce Brown' }], 'B00R6S1RCY');
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Golden Son' }));
      });

      // #1119 AC test #3 — ASIN lookup failure: raw item fields used end-to-end
      it('ASIN lookup failure: raw item fields used at create, no metadata side fields', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue(null),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Mystery Book', author: 'Some Author', asin: 'B_NOTFOUND' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Mystery Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Mystery Book',
          authors: [{ name: 'Some Author' }],
          asin: 'B_NOTFOUND',
        }));
        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.narrators).toBeUndefined();
        expect(callArgs.duration).toBeUndefined();
        expect(callArgs.seriesName).toBeUndefined();
      });

      // #1119 AC test #4 — Search-candidate validation success: metadata identity wins at create payload
      it('search-candidate path: metadata identity wins at create payload when item differs', async () => {
        const mockMetadata = {
          enrichBook: vi.fn(),
          search: vi.fn().mockResolvedValue({
            books: [{
              title: 'Game On', authors: [{ name: 'Navessa Allen' }],
              narrators: ['Real Narrator'], duration: 30000,
            }],
            authors: [], series: [],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          // Lowercased title + author match the metadata case-insensitively, so
          // validation passes; assert the metadata casing reaches the create payload.
          fetchItems: vi.fn().mockResolvedValue([{ title: 'GAME ON', author: 'navessa allen' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Game On'));
        const findDuplicate = vi.fn().mockResolvedValue(null);
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), mockMetadata,
        );
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith('Game On', [{ name: 'Navessa Allen' }], undefined);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Game On',
          authors: [{ name: 'Navessa Allen' }],
          narrators: ['Real Narrator'],
          duration: 30000,
        }));
      });

      // #1119 AC test #7 — Mismatch logging on ASIN identity
      it('ASIN-identity: emits warn log when raw and metadata fields disagree', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'Navessa Allen', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, makeBookService(), mockMetadata);
        await service.syncDueLists();

        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            asin: 'B00R6S1RCY',
            listAuthor: 'Navessa Allen',
            metadataAuthor: 'Pierce Brown',
          }),
          expect.stringContaining('Import-list ASIN identity disagrees'),
        );
      });

      // #1119 AC test #7 (negative) — no mismatch log when raw and metadata agree
      it('ASIN-identity: no mismatch log when raw and metadata agree', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'Pierce Brown', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, makeBookService(), mockMetadata);
        await service.syncDueLists();

        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const mismatchWarn = warnCalls.find((call) => {
          const msg = call[1] as string;
          return typeof msg === 'string' && msg.includes('Import-list ASIN identity disagrees');
        });
        expect(mismatchWarn).toBeUndefined();
      });

      // #1119 AC test #8 — Item with no author + metadata has authors
      it('ASIN-identity: item without author still adopts metadata author', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B_AUTHORLESS', title: 'X',
            authors: [{ name: 'Real Author' }],
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'X', asin: 'B_AUTHORLESS' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'X'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          authors: [{ name: 'Real Author' }],
        }));
      });

      // §4 — search-candidate path applies fuzzy validation
      it('search-candidate path: fuzzy mismatch falls back to provider raw fields, no enriched data', async () => {
        const mockMetadata = {
          enrichBook: vi.fn(),
          search: vi.fn().mockResolvedValue({
            books: [{
              title: 'Game On', authors: [{ name: 'Janet Evanovich' }],
              narrators: ['Wrong Narrator'], coverUrl: 'http://wrong.com/cover.jpg', asin: 'B_WRONG',
            }],
            authors: [], series: [],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'GAME ON', author: 'Navessa Allen', coverUrl: 'http://nyt/cover.jpg' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'GAME ON'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        // Author mismatch → match dropped → provider's coverUrl wins, no narrators, no asin
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'GAME ON',
          authors: [{ name: 'Navessa Allen' }],
          coverUrl: 'http://nyt/cover.jpg',
        }));
        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.narrators).toBeUndefined();
        expect(callArgs.asin).toBeUndefined();
      });

      it('search-candidate path: title fuzzy match + author overlap → match adopted, rich fields flow', async () => {
        const mockMetadata = {
          enrichBook: vi.fn(),
          search: vi.fn().mockResolvedValue({
            books: [{
              title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }],
              narrators: ['Michael Kramer'], duration: 50000, asin: 'B_MATCH',
              seriesPrimary: { name: 'The Stormlight Archive', position: 1, asin: 'SA' },
              coverUrl: 'http://match.com/cover.jpg',
            }],
            authors: [], series: [],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'The Way of Kings', author: 'Brandon Sanderson' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'The Way of Kings'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'The Way of Kings',
          authors: [{ name: 'Brandon Sanderson' }],
          narrators: ['Michael Kramer'],
          duration: 50000,
          asin: 'B_MATCH',
          seriesName: 'The Stormlight Archive',
          seriesPosition: 1,
          seriesAsin: 'SA',
          coverUrl: 'http://match.com/cover.jpg',
        }));
      });

      it('search returns no books → match=null, raw item fields used', async () => {
        const mockMetadata = {
          enrichBook: vi.fn(),
          search: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Obscure Book', author: 'Nobody' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Obscure Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.title).toBe('Obscure Book');
        expect(callArgs.narrators).toBeUndefined();
        expect(callArgs.asin).toBeUndefined();
      });

      it('metadata search throws → match=null, item still processed, warn logged', async () => {
        const mockMetadata = {
          enrichBook: vi.fn(),
          search: vi.fn().mockRejectedValue(new Error('API timeout')),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Resilient Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Resilient Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Resilient Book' }),
          expect.stringContaining('Metadata enrichment failed'),
        );
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Resilient Book' }));
      });

      // Cover precedence at insert: provider wins over match
      it('cover precedence: item.coverUrl wins over match.coverUrl', async () => {
        const mockMetadata = {
          enrichBook: vi.fn(),
          search: vi.fn().mockResolvedValue({
            books: [{
              title: 'My Book', authors: [{ name: 'My Author' }],
              coverUrl: 'http://match-cover.jpg',
            }],
            authors: [], series: [],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'My Book', author: 'My Author', coverUrl: 'http://item-cover.jpg' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'My Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({ coverUrl: 'http://item-cover.jpg' }));
      });

      // seriesPrimary preferred over series[0] (#1088 prior art)
      it('series identity: match.seriesPrimary wins over match.series[0]', async () => {
        const mockMetadata = {
          enrichBook: vi.fn().mockResolvedValue({
            asin: 'B', title: 'X', authors: [{ name: 'A' }],
            seriesPrimary: { name: 'Real Series', position: 2, asin: 'PRIM' },
            series: [{ name: 'Universe', position: 50, asin: 'UNI' }],
          }),
          search: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'X', author: 'A', asin: 'B' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'X'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          seriesName: 'Real Series', seriesPosition: 2, seriesAsin: 'PRIM',
        }));
      });
    });

    it('all processItem calls fail — lastSyncError remains null, lastRunAt updated, log.warn per item', async () => {
      const mockProvider = {
        fetchItems: vi.fn().mockResolvedValue([
          { title: 'Book A', author: 'Author' },
          { title: 'Book B', author: 'Author' },
          { title: 'Book C', author: 'Author' },
        ]),
        test: vi.fn(),
      };
      mockFactories.abs!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueAbsList({ syncIntervalMinutes: 60, name: 'Failing Items' })]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);

      const create = vi.fn().mockRejectedValue(new Error('insert failed'));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }));
      await service.syncDueLists();

      // syncList swallows per-item failures via per-item try/catch
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toBeNull();
      expect(setCall.lastRunAt).toBeInstanceOf(Date);
      const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const failedItemWarns = warnCalls.filter((call) => {
        const msg = call[1] as string;
        return typeof msg === 'string' && msg.includes('Failed to process');
      });
      expect(failedItemWarns).toHaveLength(3);
    });

    it('unknown provider type during syncList — lastSyncError persisted with error message, nextRunAt advanced', async () => {
      const db = createMockDb();
      const dueList = {
        id: 1, name: 'Unknown Type', type: 'nonexistent', enabled: true,
        settings: { serverUrl: 'http://test.local' },
        syncIntervalMinutes: 60, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      db.select.mockReturnValue(mockDbChain([dueList]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());
      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toContain('Unknown provider type');
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
      const diff = (setCall.nextRunAt as Date).getTime() - Date.now();
      expect(diff).toBeGreaterThan(59 * 60_000);
      expect(diff).toBeLessThan(61 * 60_000);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unknown Type' }),
        expect.stringContaining('sync failed'),
      );
    });

    // F9 — searchDeps wiring: honor quality.searchImmediately + new audit-vs-search ordering
    describe('searchDeps wired (#967, F9)', () => {
      it('triggers immediate search when searchImmediately=true and a new book is created', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Search Me', author: 'Search Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(42, 'Search Me'));
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined, searchDeps,
        );
        await service.syncDueLists();

        await vi.waitFor(() => expect(mockTriggerImmediateSearch).toHaveBeenCalledTimes(1));
        const [bookArg, depsArg] = mockTriggerImmediateSearch.mock.calls[0]!;
        expect(bookArg).toEqual(expect.objectContaining({ id: 42, title: 'Search Me', authors: [{ name: 'Search Author' }] }));
        expect(depsArg).toBe(searchDeps);
      });

      it('passes empty authors array when enriched.authorName is absent', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Anonymous Book' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(11, 'Anonymous Book'));
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined, searchDeps,
        );
        await service.syncDueLists();

        await vi.waitFor(() => expect(mockTriggerImmediateSearch).toHaveBeenCalledTimes(1));
        const [bookArg] = mockTriggerImmediateSearch.mock.calls[0]!;
        expect(bookArg).toEqual(expect.objectContaining({ id: 11, title: 'Anonymous Book', authors: [] }));
      });

      it('does NOT trigger when searchImmediately=false', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Quiet Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(30, 'Quiet Book'));
        const searchDeps = makeSearchDeps({ searchImmediately: false });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined, searchDeps,
        );
        await service.syncDueLists();

        expect(mockTriggerImmediateSearch).not.toHaveBeenCalled();
      });

      it('reads quality settings exactly once per syncList cycle (AC6)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Book A', author: 'Author A' },
            { title: 'Book B', author: 'Author B' },
            { title: 'Book C', author: 'Author C' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueAbsList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        let id = 70;
        const create = vi.fn().mockImplementation(async (data: { title: string }) => createdBook(id++, data.title));
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined, searchDeps,
        );
        await service.syncDueLists();

        const get = searchDeps.settingsService.get as unknown as ReturnType<typeof vi.fn>;
        const qualityCalls = get.mock.calls.filter((args) => args[0] === 'quality');
        expect(qualityCalls).toHaveLength(1);
      });
    });

    it('isolates provider failures — one list failing does not block others', async () => {
      const failProvider = { fetchItems: vi.fn().mockRejectedValue(new Error('Provider down')), test: vi.fn() };
      const successProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.abs!.mockReturnValue(failProvider);
      mockFactories.nyt!.mockReturnValue(successProvider);

      const db = createMockDb();
      const list1 = {
        id: 1, name: 'Failing ABS', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      const list2 = {
        id: 2, name: 'Working NYT', type: 'nyt', enabled: true,
        settings: { apiKey: 'key', list: 'audio-fiction' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      db.select.mockReturnValue(mockDbChain([list1, list2]));
      db.update.mockReturnValue(mockDbChain([]));

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await service.syncDueLists();

      expect(failProvider.fetchItems).toHaveBeenCalled();
      expect(successProvider.fetchItems).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Failing ABS' }),
        expect.stringContaining('sync failed'),
      );
    });
  });
});

function makeSearchDeps(quality: { searchImmediately?: boolean } = {}) {
  const get = vi.fn(async (key: string) => {
    if (key === 'quality') return { searchImmediately: false, ...quality };
    return {};
  });
  return inject<ImmediateSearchDeps>({
    indexerSearchService: {},
    downloadOrchestrator: {},
    settingsService: { get },
    blacklistService: {},
    eventBroadcaster: {},
  });
}
