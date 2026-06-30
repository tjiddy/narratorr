import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { ImportListService } from './import-list.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { MetadataService } from './metadata.service.js';
import { RateLimitError, TransientError } from '../../core/index.js';
import { initializeKey, _resetKey, encrypt, getKey } from '../utils/secret-codec.js';
import { randomBytes } from 'node:crypto';
import { mockDbChain, createMockDb, createMockLogger, inject } from '../__tests__/helpers.js';
import type { ImmediateSearchDeps } from './trigger-immediate-search.js';

// Mock the adapter factories
vi.mock('../../core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: {
    nyt: vi.fn(),
    hardcover: vi.fn(),
  },
}));

// Stub the trigger so search-pipeline isn't actually invoked from these unit tests
vi.mock('./trigger-immediate-search.js', () => ({
  triggerImmediateSearch: vi.fn(),
}));

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('../../core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as Record<string, ReturnType<typeof vi.fn>>;
const { triggerImmediateSearch } = await import('./trigger-immediate-search.js');
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
  const findDuplicate = overrides.findDuplicate ?? vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
  const create = overrides.create ?? vi.fn().mockImplementation(async (data: { title: string }): Promise<BookWithAuthor> => ({
    id: 100,
    publicId: 'bk_test000000000000000',
    title: data.title,
    subtitle: null,
    description: null,
    publisher: null,
    coverUrl: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    status: 'wanted',
    enrichmentStatus: 'pending',
    productionType: 'unknown',
    editionLabel: null,
    enrichmentAttempts: 0,
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
      mockFactories.nyt!.mockReturnValue(mockProvider);

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.testConfig({
        type: 'nyt',
        settings: { apiKey: 'key', list: 'audio-fiction' },
      });
      expect(result).toEqual({ success: true });
      expect(mockFactories.nyt).toHaveBeenCalledWith({ apiKey: 'key', list: 'audio-fiction' });
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const encryptedApiKey = encrypt('real-api-key', getKey());
        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([{
          id: 1, name: 'Existing', type: 'nyt', enabled: true,
          settings: { apiKey: encryptedApiKey, list: 'audio-fiction' },
          syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: null,
          lastSyncError: null, createdAt: new Date(),
        }]));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        const result = await service.testConfig({
          type: 'nyt',
          settings: { apiKey: '********', list: 'audio-fiction' },
          id: 1,
        });

        expect(result).toEqual({ success: true });
        expect(mockFactories.nyt).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: 'real-api-key' }),
        );
      });

      it('without id, passes sentinel literally to provider (no resolution)', async () => {
        const mockProvider = { test: vi.fn().mockResolvedValue({ success: false }), fetchItems: vi.fn() };
        mockFactories.nyt!.mockReturnValue(mockProvider);
        const db = createMockDb();
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        await service.testConfig({
          type: 'nyt',
          settings: { apiKey: '********', list: 'audio-fiction' },
        });

        expect(mockFactories.nyt).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: '********' }),
        );
      });

      it('with id for missing row returns Import list not found and skips provider factory', async () => {
        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([]));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        const result = await service.testConfig({
          type: 'nyt',
          settings: { apiKey: '********', list: 'audio-fiction' },
          id: 999,
        });

        expect(result).toEqual({ success: false, message: 'Import list not found' });
        expect(mockFactories.nyt).not.toHaveBeenCalled();
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
      db.select.mockReturnValue(mockDbChain([{ id: 1, name: 'Test', type: 'nyt', settings: {}, enabled: true }]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const results = await service.getAll();
      expect(results).toHaveLength(1);
      expect(db.select).toHaveBeenCalled();
    });

    // #1404 — decryptRow threads the injected service logger into decryptFields so a
    // corrupt/wrong-key secret surfaces a diagnostic. Uses a freshly-captured logger
    // (not the shared module-scope mockLog) and asserts the warn reaches THIS caller's
    // injected logger (would fail if `this.log` were dropped from the call).
    it('getById threads this.log: corrupt apiKey warns with entity/failedFields, passthrough preserved', async () => {
      const CORRUPT = '$ENC$not-valid-base64!!'; // $ENC$-prefixed, fails decrypt → passthrough
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([
        { id: 1, name: 'Test', type: 'nyt', enabled: true, settings: { apiKey: CORRUPT, list: 'audio-fiction' } },
      ]));
      const log = createMockLogger();
      const loggedService = new ImportListService(inject<Db>(db), inject<FastifyBaseLogger>(log), makeBookService());

      const row = await loggedService.getById(1);

      expect(log.warn).toHaveBeenCalledWith(
        { entity: 'importList', failedFields: ['apiKey'] },
        expect.stringContaining('secret.key'),
      );
      expect((row!.settings as Record<string, unknown>).apiKey).toBe(CORRUPT);
    });

    it('create encrypts API key and sets nextRunAt', async () => {
      const db = createMockDb();
      const insertChain = mockDbChain([{ id: 1, name: 'Test', type: 'nyt', settings: { apiKey: 'key', list: 'audio-fiction' }, createdAt: new Date() }]);
      db.insert.mockReturnValue(insertChain);
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.create({
        name: 'Test',
        type: 'nyt',
        enabled: true,
        syncIntervalMinutes: 1440,
        settings: { apiKey: 'test-key', list: 'audio-fiction' },
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
        id: 1, name: 'Test', type: 'nyt', enabled: true,
        settings: { apiKey: encryptedApiKey, list: 'audio-fiction' },
      };

      db.select.mockReturnValue(mockDbChain([existingRow]));
      const updateChain = mockDbChain([existingRow]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await service.update(1, {
        settings: { apiKey: '********', list: 'audio-nonfiction' },
      });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            apiKey: encryptedApiKey,
            list: 'audio-nonfiction',
          }),
        }),
      );
    });

    // #844 — entity-aware allowlist on resolveSentinelFields
    it('update rejects sentinel on a non-secret field rather than silently substituting it', async () => {
      const db = createMockDb();
      const existingRow = {
        id: 1, name: 'Test', type: 'nyt', enabled: true,
        settings: { apiKey: 'real', list: 'audio-fiction' },
      };
      db.select.mockReturnValue(mockDbChain([existingRow]));
      db.update.mockReturnValue(mockDbChain([existingRow]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      await expect(
        service.update(1, {
          settings: { list: '********', apiKey: 'still-real' },
        }),
      ).rejects.toThrow(/non-secret field: list/);
    });

    it('delete removes row from DB', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 1, name: 'Test', type: 'nyt', settings: {}, enabled: true }]));
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('syncDueLists', () => {
    const dueNytList = (overrides: Record<string, unknown> = {}) => ({
      id: 1, name: 'My NYT', type: 'nyt', enabled: true,
      settings: { apiKey: 'key', list: 'audio-fiction' },
      syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
      lastSyncError: null, createdAt: new Date(),
      ...overrides,
    });

    /**
     * Build a `BookWithAuthor`-shaped row that the bookService.create stub returns.
     * Tests assert against this shape's id/title — other fields just satisfy types.
     */
    const createdBook = (id: number, title: string): BookWithAuthor => ({
      id, publicId: `bk_test`, title,
      subtitle: null, description: null, publisher: null, coverUrl: null,
      asin: null, isbn: null, seriesName: null, seriesPosition: null,
      duration: null, publishedDate: null, genres: null,
      status: 'wanted', enrichmentStatus: 'pending', productionType: 'unknown', editionLabel: null,
      enrichmentAttempts: 0,
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
      mockFactories.nyt!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueNytList({ id: 7, name: 'My List' })]));
      const eventInsertChain = mockDbChain([]);
      db.insert.mockReturnValue(eventInsertChain);
      db.update.mockReturnValue(mockDbChain([]));

      const create = vi.fn().mockResolvedValue(createdBook(42, 'New Book'));
      const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }));

      await service.syncDueLists();

      expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'New Book', authors: [{ name: 'Author Name' }] }));
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'New Book',
        authors: [{ name: 'Author Name' }],
        status: 'wanted',
        importListId: 7,
      }));
      expect(eventInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 42,
          eventType: 'book_added',
          source: 'import_list',
          authorName: 'Author Name',
          reason: expect.objectContaining({ importListName: 'My List' }),
        }),
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
      mockFactories.nyt!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueNytList({ name: 'Mixed List' })]));
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
      mockFactories.nyt!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueNytList({ id: 5, syncIntervalMinutes: 60, lastSyncError: 'old error' })]));
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
      mockFactories.nyt!.mockReturnValue(failProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueNytList({ id: 3, name: 'Failing List' })]));
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        const eventInsertChain = mockDbChain([]);
        db.insert.mockReturnValue(eventInsertChain);
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'same-recording', book: { id: 999, title: 'Already Have' } });
        const create = vi.fn();
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue(null),
        } as unknown as MetadataService;
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }), mockMetadata, searchDeps,
        );

        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Already Have', authors: [{ name: 'Someone' }], asin: 'B_DUP' }));
        expect(create).not.toHaveBeenCalled();
        // No event row written
        expect(eventInsertChain.values).not.toHaveBeenCalledWith(
          expect.objectContaining({ source: 'import_list' }),
        );
        expect(mockTriggerImmediateSearch).not.toHaveBeenCalled();
        expect(mockLog.debug).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Already Have' }),
          expect.stringContaining('Book already exists (same recording), skipped'),
        );
      });

      it('authorless dedup: passes authorList: undefined to findDuplicate (NOT [{ name: undefined }])', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Anonymous Book' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        const create = vi.fn().mockResolvedValue(createdBook(11, 'Anonymous Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }));

        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Anonymous Book' }));
        expect(findDuplicate.mock.calls[0]![0]).not.toHaveProperty('authors');
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Anonymous Book', authors: [] }));
      });

      // #1723 F8 — create-time ASIN race: the pre-create guard says
      // different-recording, but create() fail-closes with OwnedRecordingError.
      // createImportListBook maps that to an owned skip (returns null) → no event
      // row, no immediate search.
      it('owned ASIN race (create throws OwnedRecordingError): skips, no event, no immediate search (#1723 F8)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Race Book', author: 'Someone', asin: 'B_RACE' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        const eventInsertChain = mockDbChain([]);
        db.insert.mockReturnValue(eventInsertChain);
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        const create = vi.fn().mockRejectedValue(
          new OwnedRecordingError({ existingBookId: 321, title: 'Race Book', reason: 'asin-owned' }),
        );
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }), undefined, searchDeps,
        );

        await service.syncDueLists();

        expect(create).toHaveBeenCalledTimes(1);
        expect(eventInsertChain.values).not.toHaveBeenCalledWith(
          expect.objectContaining({ source: 'import_list' }),
        );
        expect(mockTriggerImmediateSearch).not.toHaveBeenCalled();
      });

      // #1735 — a `review` verdict (uncertain identity) is still skipped on
      // automated lists (no held-review UI), but it is now OBSERVABLE: it emits a
      // `recording_review_skipped` event so the held candidate is queryable via the
      // existing event-history surface instead of being lost to a server log line.
      // No create, no immediate search. The mock returns a realistic review
      // resolution carrying the incumbent (NOT `book: null`, which diverges from the
      // real `resolveDuplicate` contract — see DV2).
      it('review verdict: skips create but emits an observable recording_review_skipped event (#1735)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Maybe Owned', author: 'Someone', asin: 'B_REVIEW' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList({ name: 'Review List' })]));
        const eventInsertChain = mockDbChain([]);
        db.insert.mockReturnValue(eventInsertChain);
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({
          verdict: 'review',
          book: { id: 999, title: 'Owned Incumbent' },
          hasIncumbent: true,
        });
        const create = vi.fn();
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }), undefined, searchDeps,
        );

        await service.syncDueLists();

        expect(create).not.toHaveBeenCalled();
        // The disposition is now observable outside logs: a recording_review_skipped
        // row on the incumbent's history, carrying the list name + incumbent id.
        expect(eventInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({
            bookId: 999,
            bookTitle: 'Maybe Owned',
            authorName: 'Someone',
            eventType: 'recording_review_skipped',
            source: 'import_list',
            reason: expect.objectContaining({ importListName: 'Review List', existingBookId: 999 }),
          }),
        );
        // A held item is wanted-but-uncertain, not grabbed: no immediate search.
        expect(mockTriggerImmediateSearch).not.toHaveBeenCalled();
        // #1735 — branch-specific info log distinguishes the review skip from the
        // same-recording skip (which logs at `debug` with a different message).
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Maybe Owned', asin: 'B_REVIEW', existingBookId: 999 }),
          expect.stringContaining('needs recording review'),
        );
      });

      // #1735 — the run distinguishes "synced N vs. held/skipped-for-review M": the
      // sync-complete log carries a createdCount and heldReviewCount so a held item
      // is no longer indistinguishable from a clean run.
      it('sync-complete log surfaces createdCount vs heldReviewCount for a mixed run (#1735)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Fresh Book', author: 'Author One' },
            { title: 'Held Book', author: 'Author Two' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList({ id: 9, name: 'Mixed Run' })]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn()
          .mockResolvedValueOnce({ verdict: 'different-recording', book: null })
          .mockResolvedValueOnce({ verdict: 'review', book: { id: 555, title: 'Owned' }, hasIncumbent: true });
        const create = vi.fn().mockResolvedValue(createdBook(70, 'Fresh Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }));

        await service.syncDueLists();

        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ id: 9, name: 'Mixed Run', createdCount: 1, heldReviewCount: 1 }),
          expect.stringContaining('Import list sync completed'),
        );
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
      it('item has ASIN → resolveBook called with item identity; metadata identity + side fields flow to BookService.create', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B002', title: 'Different Title From Audnexus', authors: [{ name: 'Audnexus Author' }],
            narrators: ['Narrator A', 'Narrator B'],
            seriesPrimary: { name: 'Real Series', position: 3, asin: 'SER1' },
            series: [{ name: 'Broader Universe', position: 99, asin: 'UNI1' }],
            duration: 36000, publishedDate: '2020-01-01', genres: ['Fantasy'],
            description: 'rich description', coverUrl: 'http://audnexus/cover.jpg',
            subtitle: 'Audnexus Subtitle', publisher: 'Audnexus Publisher',
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Item Title', author: 'Item Author', asin: 'B002' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Different Title From Audnexus'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(mockMetadata.resolveBook).toHaveBeenCalledWith(
          expect.objectContaining({ asin: 'B002', title: 'Item Title', author: 'Item Author' }),
        );

        // Metadata identity wins for title + authors; cover/description still
        // accept the raw item value as a hint (item.* ?? match.*); rich
        // match-only fields flow through. seriesPrimary wins over series[0].
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Different Title From Audnexus',
          authors: [{ name: 'Audnexus Author' }],
          asin: 'B002',
          narrators: ['Narrator A', 'Narrator B'],
          subtitle: 'Audnexus Subtitle',
          publisher: 'Audnexus Publisher',
          seriesName: 'Real Series',
          seriesPosition: 3,
          seriesAsin: 'SER1',
          duration: 36000,
          publishedDate: '2020-01-01',
          genres: ['Fantasy'],
        }));
      });

      // #1731 — production_type is populated from the matched record's formatType
      // on the import-list create path (previously dropped → always 'unknown').
      it('matched item with a mixed-case formatType flows normalized productionType to create (#1731)', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B002', title: 'Matched Title', authors: [{ name: 'Matched Author' }],
            formatType: 'Unabridged',
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Item', author: 'Author', asin: 'B002' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(11, 'Matched Title'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'unabridged' }));
      });

      it('matched item with no formatType leaves productionType unset → create takes the DB default (#1731)', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B002', title: 'Matched Title', authors: [{ name: 'Matched Author' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Item', author: 'Author', asin: 'B002' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(12, 'Matched Title'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create.mock.calls[0]![0].productionType).toBeUndefined();
      });

      it('unmatched (raw) item carries no production signal to create (#1731 F1)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Raw Only', author: 'Raw Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(13, 'Raw Only'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }));
        await service.syncDueLists();

        expect(create.mock.calls[0]![0].productionType).toBeUndefined();
      });

      // #1119 AC test #1 — ASIN-identity: metadata author + title win at the
      // create payload (replaces the prior `ASIN-identity path skips §4 fuzzy
      // validation` test that blessed the chimera behavior).
      it('ASIN-identity: metadata author + title win at create + findDuplicate', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
            narrators: ['Tim Gerard Reynolds'], duration: 64000,
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'Navessa Allen', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Golden Son'));
        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), mockMetadata,
        );
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Golden Son', authors: [{ name: 'Pierce Brown' }], asin: 'B00R6S1RCY' }));
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
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'golden son (unabridged)', author: 'Pierce Brown', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Golden Son'));
        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), mockMetadata,
        );
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Golden Son', authors: [{ name: 'Pierce Brown' }], asin: 'B00R6S1RCY' }));
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Golden Son' }));
      });

      // #1622 — unresolvable item: raw item fields used end-to-end AND the book
      // is created with enrichmentStatus 'failed' (still created so the import
      // isn't dropped; re-enters the background job's retry-after-1h search).
      it('unresolvable item (resolver null): raw item fields at create + enrichmentStatus failed, no metadata side fields', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue(null),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Mystery Book', author: 'Some Author', asin: 'B_NOTFOUND' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Mystery Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        // The resolver receives the transient item identity (asin NOT mutated on
        // the import-list row — the adapter item is just passed through).
        expect(mockMetadata.resolveBook).toHaveBeenCalledWith(
          expect.objectContaining({ asin: 'B_NOTFOUND', title: 'Mystery Book', author: 'Some Author' }),
        );
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Mystery Book',
          authors: [{ name: 'Some Author' }],
          asin: 'B_NOTFOUND',
          enrichmentStatus: 'failed',
        }));
        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.narrators).toBeUndefined();
        expect(callArgs.duration).toBeUndefined();
        expect(callArgs.seriesName).toBeUndefined();
      });

      // #1622 — bad provider ASIN rescued via search: the resolved AUDIOBOOK ASIN
      // (not the original print/Kindle ASIN) is what's persisted for the book.
      it('search-rescued ASIN: resolved audiobook ASIN wins over the raw provider ASIN at create', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B0AUDIOBOOK', title: 'Catching Fire', authors: [{ name: 'Suzanne Collins' }],
            narrators: ['Carolyn McCormick'], duration: 700,
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          // Print ASIN (ISBN-10 shaped) from a Hardcover-style provider row.
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Catching Fire', author: 'Suzanne Collins', asin: '1338589016' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Catching Fire'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Catching Fire',
          asin: 'B0AUDIOBOOK',
          narrators: ['Carolyn McCormick'],
          duration: 700,
        }));
        // The book record gets the audiobook ASIN — NOT the print ASIN.
        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.asin).not.toBe('1338589016');
      });

      // #1622 — a provider RateLimitError is transient, NOT a no-match: the book
      // is still created but left resolvable later (no 'failed' status); logged.
      it('rate limit during resolution: book left pending (not failed), warn logged', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockRejectedValue(new RateLimitError(30000, 'Audible.com')),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Rate Limited Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Rate Limited Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.enrichmentStatus).toBeUndefined(); // default 'pending', NOT 'failed'
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Rate Limited Book', provider: 'Audible.com', retryAfterMs: 30000 }),
          expect.stringContaining('rate limited'),
        );
      });

      // #1628 — a transient provider failure during the fallback search is NOT a
      // no-match: the book is still created but left pending (no 'failed' status),
      // so the background job retries it. Mirrors the rate-limit case above.
      it('transient error during resolution: book left pending (not failed), warn logged', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockRejectedValue(new TransientError('Audible.com', 'HTTP 503')),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Transient Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Transient Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.enrichmentStatus).toBeUndefined(); // default 'pending', NOT 'failed'
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Transient Book', provider: 'Audible.com' }),
          expect.stringContaining('transient'),
        );
      });

      // #1628 — a generic (non-typed) error during resolution is also treated as
      // transient: book created but left pending, not failed.
      it('generic error during resolution: book left pending (not failed)', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockRejectedValue(new Error('Network error')),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Network Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Network Book'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.enrichmentStatus).toBeUndefined(); // default 'pending', NOT 'failed'
      });

      // #1119 AC test #4 — Search-candidate validation success: metadata identity wins at create payload
      it('search-candidate path: metadata identity wins at create payload when item differs', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            title: 'Game On', authors: [{ name: 'Navessa Allen' }],
            narrators: ['Real Narrator'], duration: 30000,
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          // Lowercased title + author match the metadata case-insensitively, so
          // validation passes; assert the metadata casing reaches the create payload.
          fetchItems: vi.fn().mockResolvedValue([{ title: 'GAME ON', author: 'navessa allen' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'Game On'));
        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), mockMetadata,
        );
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Game On', authors: [{ name: 'Navessa Allen' }] }));
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
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'Navessa Allen', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
          expect.stringContaining('Import-list metadata disagrees with raw provider fields'),
        );
      });

      // #1119 AC test #7 (negative) — no mismatch log when raw and metadata agree
      it('ASIN-identity: no mismatch log when raw and metadata agree', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'Pierce Brown', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, makeBookService(), mockMetadata);
        await service.syncDueLists();

        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const mismatchWarn = warnCalls.find((call) => {
          const msg = call[1] as string;
          return typeof msg === 'string' && msg.includes('Import-list metadata disagrees with raw provider fields');
        });
        expect(mismatchWarn).toBeUndefined();
      });

      // #1626 — case-only title divergence does NOT warn (author agrees)
      it('case-only title divergence does not emit mismatch warn when author agrees', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Game On',
            authors: [{ name: 'Navessa Allen' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'GAME ON', author: 'Navessa Allen', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, makeBookService(), mockMetadata);
        await service.syncDueLists();

        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const mismatchWarn = warnCalls.find((call) => {
          const msg = call[1] as string;
          return typeof msg === 'string' && msg.includes('Import-list metadata disagrees with raw provider fields');
        });
        expect(mismatchWarn).toBeUndefined();
      });

      // #1626 — case-only title divergence does NOT warn (author absent)
      it('case-only title divergence does not emit mismatch warn when author is absent', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Game On',
            authors: [{ name: 'Navessa Allen' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'GAME ON', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, makeBookService(), mockMetadata);
        await service.syncDueLists();

        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const mismatchWarn = warnCalls.find((call) => {
          const msg = call[1] as string;
          return typeof msg === 'string' && msg.includes('Import-list metadata disagrees with raw provider fields');
        });
        expect(mismatchWarn).toBeUndefined();
      });

      // #1626 — case-only author divergence does NOT warn (title agrees)
      it('case-only author divergence does not emit mismatch warn when title agrees', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B00R6S1RCY', title: 'Golden Son',
            authors: [{ name: 'Pierce Brown' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Golden Son', author: 'pierce brown', asin: 'B00R6S1RCY' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, makeBookService(), mockMetadata);
        await service.syncDueLists();

        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const mismatchWarn = warnCalls.find((call) => {
          const msg = call[1] as string;
          return typeof msg === 'string' && msg.includes('Import-list metadata disagrees with raw provider fields');
        });
        expect(mismatchWarn).toBeUndefined();
      });

      // #1119 AC test #8 — Item with no author + metadata has authors
      it('ASIN-identity: item without author still adopts metadata author', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B_AUTHORLESS', title: 'X',
            authors: [{ name: 'Real Author' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'X', asin: 'B_AUTHORLESS' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(10, 'X'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata);
        await service.syncDueLists();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          authors: [{ name: 'Real Author' }],
        }));
      });

      // §4 — resolver rejects the candidate (validation lives in resolveBook now)
      // → null → raw provider fields fall through, no enriched data.
      it('resolver returns null (validation rejected) → falls back to provider raw fields, no enriched data', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue(null),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'GAME ON', author: 'Navessa Allen', coverUrl: 'http://nyt/cover.jpg' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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

      it('search-candidate path: resolver returns a validated match → rich fields flow (incl. resolved audiobook ASIN)', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }],
            narrators: ['Michael Kramer'], duration: 50000, asin: 'B_MATCH',
            seriesPrimary: { name: 'The Stormlight Archive', position: 1, asin: 'SA' },
            coverUrl: 'http://match.com/cover.jpg',
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'The Way of Kings', author: 'Brandon Sanderson' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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

      it('resolver returns null (no match) → raw item fields used', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue(null),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Obscure Book', author: 'Nobody' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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

      it('resolver throws (non-rate-limit) → match=null, item still processed, warn logged', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockRejectedValue(new Error('API timeout')),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Resilient Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
          resolveBook: vi.fn().mockResolvedValue({
            title: 'My Book', authors: [{ name: 'My Author' }],
            coverUrl: 'http://match-cover.jpg',
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'My Book', author: 'My Author', coverUrl: 'http://item-cover.jpg' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B', title: 'X', authors: [{ name: 'A' }],
            seriesPrimary: { name: 'Real Series', position: 2, asin: 'PRIM' },
            series: [{ name: 'Universe', position: 50, asin: 'UNI' }],
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'X', author: 'A', asin: 'B' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
      mockFactories.nyt!.mockReturnValue(mockProvider);

      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([dueNytList({ syncIntervalMinutes: 60, name: 'Failing Items' })]));
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
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
      mockFactories.hardcover!.mockReturnValue(failProvider);
      mockFactories.nyt!.mockReturnValue(successProvider);

      const db = createMockDb();
      const list1 = {
        id: 1, name: 'Failing Hardcover', type: 'hardcover', enabled: true,
        settings: { apiKey: 'key', listType: 'trending' },
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
        expect.objectContaining({ name: 'Failing Hardcover' }),
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
