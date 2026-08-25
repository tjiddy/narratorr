import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { ImportListService } from './import-list.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import { OwnedRecordingError } from './book-dedup.js';
import { TaskRegistry, TaskRegistryError } from './task-registry.js';
import type { MetadataService } from './metadata.service.js';
import { RateLimitError, TransientError } from '@core/index.js';
import { ImportListError } from '@core/import-lists/errors.js';
import { initializeKey, _resetKey, encrypt, getKey } from '../utils/secret-codec.js';
import { randomBytes } from 'node:crypto';
import { mockDbChain, createMockDb, createMockLogger, inject } from '../__tests__/helpers.js';
import type { ImmediateSearchDeps } from './trigger-immediate-search.js';
import type { ImportListExclusionService } from './import-list-exclusion.service.js';
import { expectNoLeak, makeLeakyDrizzleError } from '../__tests__/drizzle-error.fixture.js';

vi.mock('@core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: {
    nyt: vi.fn(),
    hardcover: vi.fn(),
  },
}));

// Prevent unit tests from invoking the real search pipeline.
vi.mock('./trigger-immediate-search.js', () => ({
  triggerImmediateSearch: vi.fn(),
  runImmediateSearch: vi.fn(),
}));

// The AC5 containment case runs the REAL `runImmediateSearch` so its own try/catch is what the
// assertion depends on; stubbing its one live dependency is how a search failure can originate
// where production's catch sees it.
vi.mock('./search-pipeline.js', () => ({
  searchAndGrabForBook: vi.fn(),
  buildNarratorPriority: vi.fn(() => []),
  buildSearchFilterOptions: vi.fn(() => ({})),
}));

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('@core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as Record<string, ReturnType<typeof vi.fn>>;
const { triggerImmediateSearch, runImmediateSearch } = await import('./trigger-immediate-search.js');
const mockTriggerImmediateSearch = triggerImmediateSearch as unknown as ReturnType<typeof vi.fn>;
const mockRunImmediateSearch = runImmediateSearch as unknown as ReturnType<typeof vi.fn>;
const { runImmediateSearch: realRunImmediateSearch } =
  await vi.importActual<typeof import('./trigger-immediate-search.js')>('./trigger-immediate-search.js');
const { searchAndGrabForBook } = await import('./search-pipeline.js');
const mockSearchAndGrabForBook = searchAndGrabForBook as unknown as ReturnType<typeof vi.fn>;

const mockLog = createMockLogger() as unknown as FastifyBaseLogger;

/** Fixed instant for the manual-run schedule assertions, so a window becomes an equality. */
const NOW_MS = Date.UTC(2026, 7, 14, 12, 0, 0);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Drain the microtask queue so an in-flight chain settles onto its next gate. */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function makeBookService(overrides: {
  findDuplicate?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  getById?: ReturnType<typeof vi.fn>;
} = {}): BookService {
  // Widened with the pipeline (#2246): the owned-race arm hydrates the incumbent through `getById`.
  // `inject<BookService>` erases property checking, so typecheck cannot see the gap — an unstubbed
  // method reaches production as a swallowed TypeError, not a failure.
  const getById = overrides.getById ?? vi.fn().mockResolvedValue(null);
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
  return inject<BookService>({ findDuplicate, create, getById });
}

describe('ImportListService', () => {
  let service: ImportListService;

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, and the chain tests install per-book gating ones that
    // would otherwise stall an unrelated test (see [[vitest-clearallmocks-once-queue]]).
    mockRunImmediateSearch.mockReset();
    mockSearchAndGrabForBook.mockReset();
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

    // T38 (#2604). The reviewer's scenario: an edit-mode connection test whose saved-settings
    // lookup throws. `import-list.service.ts` is not edited by this issue — the summary reaches
    // the result union through `getErrorMessage` alone.
    it('renders a DB failure from the saved-settings lookup as the summary', async () => {
      const db = createMockDb();
      db.select.mockImplementation(() => { throw makeLeakyDrizzleError(); });
      service = new ImportListService(inject<Db>(db), mockLog, makeBookService());

      const result = await service.testConfig({ type: 'nyt', settings: { apiKey: 'key' }, id: 7 });

      expect(result.success).toBe(false);
      expectNoLeak(result.message!);
      expect(result.message).toContain('FOREIGN KEY constraint failed');
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

    // A fresh logger exposes any accidental fallback to the shared module mock.
    it('getById threads this.log: corrupt apiKey warns with entity/failedFields, passthrough preserved', async () => {
      const CORRUPT = '$ENC$not-valid-base64!!';
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
        expect(eventInsertChain.values).not.toHaveBeenCalledWith(
          expect.objectContaining({ source: 'import_list' }),
        );
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
        expect(mockLog.debug).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Already Have' }),
          expect.stringContaining('Book already exists (same recording), skipped'),
        );
      });

      // #2435 AC3: import-list sync reaches the decision through addBook, not a direct
      // findDuplicate call, so it inherits addBook's answer — a fileless incumbent is still owned.
      // Driven through the real syncDueLists path; a stubbed findDuplicate would prove nothing
      // about the surface this fences.
      it('still skips a FILELESS wanted incumbent — no second book (#2435 AC3)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Already Wanted', author: 'Someone', asin: 'B_WANT' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({
          verdict: 'same-recording',
          book: { id: 999, title: 'Already Wanted', path: null, status: 'wanted' },
        });
        const create = vi.fn();
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }),
          { resolveBook: vi.fn().mockResolvedValue(null) } as unknown as MetadataService,
          makeSearchDeps({ searchImmediately: true }),
        );

        await service.syncDueLists();

        expect(create).not.toHaveBeenCalled();
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
      });

      // The candidate carried no `authors` key before #2246 and carries `[]` after it, because the
      // shared write item requires an author list. `gatherIncumbentIds` gates on `length > 0` and
      // `toRecordingCandidate` coalesces to `[]`, so both reach the resolver as "no author
      // evidence"; the property under test is still that no `{ name: undefined }` entry is built.
      it('authorless dedup: passes an empty author list to findDuplicate (NOT [{ name: undefined }])', async () => {
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
        expect(findDuplicate.mock.calls[0]![0].authors).toEqual([]);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Anonymous Book', authors: [] }));
      });

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
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
      });

      // Real review resolutions carry the incumbent; `book: null` cannot exercise this contract.
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
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Maybe Owned', asin: 'B_REVIEW', existingBookId: 999 }),
          expect.stringContaining('needs recording review'),
        );
      });

      // The committed row is the point of no return, so the bookkeeping write cannot un-create it.
      it('counts the item created when its book_added write rejects after the row committed (#2231)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Committed Book', author: 'Author One' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList({ id: 12, name: 'Rejecting List' })]));
        db.insert.mockReturnValue(mockDbChain([], { error: new Error('events table locked') }));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockResolvedValue(createdBook(88, 'Committed Book'));
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined, searchDeps,
        );

        await service.syncDueLists();

        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ id: 12, createdCount: 1, heldReviewCount: 0 }),
          expect.stringContaining('Import list sync completed'),
        );
        // The row still enters the search pipeline; only the bookkeeping write is lost.
        expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 88 }),
          expect.stringContaining('Failed to record book_added event'),
        ));
      });

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

        const eventValuesCalls = eventInsertChain.values.mock.calls as unknown[][];
        const badItemEvent = eventValuesCalls.find((call) => {
          const v = call[0] as { bookTitle?: string };
          return v.bookTitle === 'Bad Item';
        });
        expect(badItemEvent).toBeUndefined();

        expect(create).toHaveBeenCalledTimes(2);
        const goodEvent = eventValuesCalls.find((call) => {
          const v = call[0] as { bookTitle?: string };
          return v.bookTitle === 'Good Item';
        });
        expect(goodEvent).toBeDefined();

        const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
        const failWarn = warnCalls.find((call) => {
          const ctx = call[0] as { title?: string };
          const msg = call[1] as string;
          return ctx.title === 'Bad Item' && typeof msg === 'string' && msg.includes('Failed to process');
        });
        expect(failWarn).toBeDefined();

        expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
        const [bookArg] = mockRunImmediateSearch.mock.calls[0]!;
        expect(bookArg).toEqual(expect.objectContaining({ id: 20, title: 'Good Item' }));
      });
    });

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

        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Different Title From Audnexus',
          authors: [{ name: 'Audnexus Author' }],
          asin: 'B002',
          narrators: ['Narrator A', 'Narrator B'],
          subtitle: 'Audnexus Subtitle',
          publisher: 'Audnexus Publisher',
          seriesName: 'Real Series',
          seriesPosition: 3,
          duration: 36000,
          publishedDate: '2020-01-01',
          genres: ['Fantasy'],
        }));
      });

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

      it('matched item forwards productionType to findDuplicate and surfaces recordingReviewReason in the held event (#1728 F1/F4)', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B100', title: 'Held Title', authors: [{ name: 'Held Author' }],
            narrators: ['Jim Dale'], formatType: 'Unabridged',
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Held Title', author: 'Held Author', asin: 'B100' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList({ name: 'Veto List' })]));
        const eventInsertChain = mockDbChain([]);
        db.insert.mockReturnValue(eventInsertChain);
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({
          verdict: 'review',
          book: { id: 321, title: 'Owned Abridged' },
          hasIncumbent: true,
          recordingReviewReason: 'production-type-mismatch',
        });
        const create = vi.fn();
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }), mockMetadata);
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'unabridged' }));
        expect(create).not.toHaveBeenCalled();
        expect(eventInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'recording_review_skipped',
            reason: expect.objectContaining({ recordingReviewReason: 'production-type-mismatch', existingBookId: 321 }),
          }),
        );
      });

      it('unmatched (raw) item passes NO productionType to findDuplicate — unchanged behavior (#1728 F1)', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Raw Only', author: 'Raw Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        const create = vi.fn().mockResolvedValue(createdBook(14, 'Raw Only'));
        service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ findDuplicate, create }));
        await service.syncDueLists();

        expect(findDuplicate).toHaveBeenCalledTimes(1);
        expect(findDuplicate.mock.calls[0]![0]).not.toHaveProperty('productionType');
      });

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

      it('search-rescued ASIN: resolved audiobook ASIN wins over the raw provider ASIN at create', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B0AUDIOBOOK', title: 'Catching Fire', authors: [{ name: 'Suzanne Collins' }],
            narrators: ['Carolyn McCormick'], duration: 700,
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          // ISBN-10-shaped print ASIN from a Hardcover-style provider.
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
        const callArgs = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(callArgs.asin).not.toBe('1338589016');
      });

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
        expect(callArgs.enrichmentStatus).toBeUndefined(); // Database default: pending.
      });

      it('search-candidate path: metadata identity wins at create payload when item differs', async () => {
        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            title: 'Game On', authors: [{ name: 'Navessa Allen' }],
            narrators: ['Real Narrator'], duration: 30000,
          }),
        } as unknown as MetadataService;
        const mockProvider = {
          // Case-only differences pass validation while preserving metadata casing.
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
          seriesName: 'Real Series', seriesPosition: 2,
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

        expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
        const [bookArg, depsArg] = mockRunImmediateSearch.mock.calls[0]!;
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

        expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
        const [bookArg] = mockRunImmediateSearch.mock.calls[0]!;
        expect(bookArg).toEqual(expect.objectContaining({ id: 11, title: 'Anonymous Book', authors: [] }));
      });

      // AC4: the query must key on the identity the row was ADOPTED under, not the shelf's. The
      // created row's own `authors` cannot stand in — `BookService.create` is what hydrates those,
      // and the pipeline returns the primary author it wrote with precisely so this survives.
      it('searches under the resolved primary author, never the shelf item\'s', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Shelf Title', author: 'Shelf Author' }]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const mockMetadata = {
          resolveBook: vi.fn().mockResolvedValue({
            asin: 'B_RESOLVED', title: 'Resolved Title', authors: [{ name: 'Resolved Author' }], narrators: [],
          }),
        } as unknown as MetadataService;
        const create = vi.fn().mockResolvedValue(createdBook(51, 'Resolved Title'));
        const searchDeps = makeSearchDeps({ searchImmediately: true });
        service = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), mockMetadata, searchDeps,
        );
        await service.syncDueLists();

        expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
        const [bookArg] = mockRunImmediateSearch.mock.calls[0]!;
        expect(bookArg).toEqual(expect.objectContaining({
          id: 51, title: 'Resolved Title', authors: [{ name: 'Resolved Author' }],
        }));
        expect(JSON.stringify(bookArg)).not.toContain('Shelf Author');
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

        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
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

    // #2304: the detached per-item trigger put N books' searches in flight at once, which
    // rate-limited MAM and timed Prowlarr out. The chain is collected after creation and awaited.
    describe('serial search chain (#2304)', () => {
      interface ChainHarness {
        service: ImportListService;
        create: ReturnType<typeof vi.fn>;
        findDuplicate: ReturnType<typeof vi.fn>;
        provider: { fetchItems: ReturnType<typeof vi.fn>; test: ReturnType<typeof vi.fn> };
        updateChain: ReturnType<typeof mockDbChain>;
      }

      /** One due NYT list whose items are `titles`, each creating a book with id = index + 1. */
      const harness = (
        titles: string[],
        opts: { searchImmediately?: boolean; withSearchDeps?: boolean } = {},
      ): ChainHarness => {
        const provider = {
          fetchItems: vi.fn().mockResolvedValue(titles.map((title) => ({ title, author: `${title} Author` }))),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(provider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        const updateChain = mockDbChain([]);
        db.update.mockReturnValue(updateChain);

        const ids = new Map(titles.map((title, index) => [title, index + 1]));
        const create = vi.fn().mockImplementation(async (data: { title: string }) =>
          createdBook(ids.get(data.title) ?? 0, data.title));
        const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        const searchDeps = opts.withSearchDeps === false
          ? undefined
          : makeSearchDeps({ searchImmediately: opts.searchImmediately ?? true });

        return {
          service: new ImportListService(
            inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), undefined, searchDeps,
          ),
          create, findDuplicate, provider, updateChain,
        };
      };

      const titleOf = (mock: ReturnType<typeof vi.fn>) =>
        (mock.mock.calls as [{ title: string }][]).map(([arg]) => arg.title);

      it('never has more than one book search in flight, and searches in item order (AC1)', async () => {
        const { service: svc, create } = harness(['A', 'B', 'C', 'D']);
        const gates = new Map(['A', 'B', 'C', 'D'].map((title) => [title, deferred()]));
        const trace: string[] = [];
        mockRunImmediateSearch.mockImplementation(async (book: { title: string }) => {
          trace.push(`start:${book.title}`);
          await gates.get(book.title)!.promise;
          trace.push(`end:${book.title}`);
        });

        const sync = svc.syncDueLists();
        await flush();
        expect(create).toHaveBeenCalledTimes(4);
        expect(trace).toEqual(['start:A']);

        gates.get('A')!.resolve();
        await flush();
        expect(trace).toEqual(['start:A', 'end:A', 'start:B']);

        gates.get('B')!.resolve();
        await flush();
        expect(trace).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C']);

        gates.get('C')!.resolve();
        gates.get('D')!.resolve();
        await sync;
        expect(trace).toEqual([
          'start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C', 'start:D', 'end:D',
        ]);
        // The detached wrapper is what put ~109 searches in flight; this path must not reach it.
        expect(mockTriggerImmediateSearch).not.toHaveBeenCalled();
      });

      it('creates every book before the first search starts (AC2, AC3)', async () => {
        const { service: svc, create } = harness(['A', 'B', 'C']);
        const gate = deferred();
        mockRunImmediateSearch.mockImplementation(async () => { await gate.promise; });

        const sync = svc.syncDueLists();
        await flush();

        expect(titleOf(create)).toEqual(['A', 'B', 'C']);
        expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);

        gate.resolve();
        await sync;
        expect(titleOf(mockRunImmediateSearch)).toEqual(['A', 'B', 'C']);
      });

      it('adds no wait of its own — the chain completes with fake timers never advanced (AC4)', async () => {
        vi.useFakeTimers();
        try {
          const { service: svc } = harness(['A', 'B', 'C']);
          mockRunImmediateSearch.mockResolvedValue(undefined);

          await svc.syncDueLists();

          expect(titleOf(mockRunImmediateSearch)).toEqual(['A', 'B', 'C']);
        } finally {
          vi.useRealTimers();
        }
      });

      it('a slow search delays the chain and nothing else (AC4)', async () => {
        vi.useFakeTimers();
        try {
          const { service: svc, updateChain } = harness(['Slow', 'Next']);
          mockRunImmediateSearch.mockImplementation(async (book: { title: string }) => {
            if (book.title === 'Slow') await new Promise((resolve) => { setTimeout(resolve, 240_000); });
          });

          const sync = svc.syncDueLists();
          await vi.advanceTimersByTimeAsync(240_000);
          await sync;

          expect(titleOf(mockRunImmediateSearch)).toEqual(['Slow', 'Next']);
          expect((updateChain.set.mock.calls[0]![0] as Record<string, unknown>).lastSyncError).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      // Runs the real `runImmediateSearch`: AC5 forbids the chain adding its own try/catch, so the
      // helper's is the only containment and deleting it must red this test.
      it('a failed search does not stop the chain, fail the sync, or alter nextRunAt (AC5)', async () => {
        const { service: svc, create, updateChain } = harness(['A', 'Boom', 'C']);
        mockRunImmediateSearch.mockImplementation(realRunImmediateSearch);
        mockSearchAndGrabForBook.mockImplementation(async (book: { title: string }) => {
          if (book.title === 'Boom') throw new Error('indexer down');
        });

        await svc.syncDueLists();

        expect(titleOf(mockSearchAndGrabForBook)).toEqual(['A', 'Boom', 'C']);
        expect(titleOf(create)).toEqual(['A', 'Boom', 'C']);
        const setCall = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
        expect(setCall.lastSyncError).toBeNull();
        expect(setCall.nextRunAt).toBeInstanceOf(Date);
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 2 }),
          'Search-immediately trigger failed',
        );
      });

      it('an item whose creation throws is absent from the chain and from createdCount (AC5)', async () => {
        const { service: svc, create } = harness(['A', 'Bad', 'C']);
        create.mockImplementation(async (data: { title: string }) => {
          if (data.title === 'Bad') throw new Error('insert failed');
          return createdBook(data.title === 'A' ? 1 : 3, data.title);
        });
        mockRunImmediateSearch.mockResolvedValue(undefined);

        await svc.syncDueLists();

        expect(titleOf(mockRunImmediateSearch)).toEqual(['A', 'C']);
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ createdCount: 2, heldReviewCount: 0 }),
          expect.stringContaining('Import list sync completed'),
        );
      });

      it('searches nothing and leaves no chain pending when the list created no books (AC7)', async () => {
        const { service: svc, findDuplicate, create } = harness(['Owned One', 'Owned Two']);
        findDuplicate.mockResolvedValue({ verdict: 'same-recording', book: { id: 999, title: 'Owned' } });
        mockRunImmediateSearch.mockResolvedValue(undefined);

        await svc.syncDueLists();

        expect(create).not.toHaveBeenCalled();
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
      });

      it('searches the single created book and resolves (AC7)', async () => {
        const { service: svc } = harness(['Only One']);
        mockRunImmediateSearch.mockResolvedValue(undefined);

        await svc.syncDueLists();

        expect(titleOf(mockRunImmediateSearch)).toEqual(['Only One']);
      });

      it('searches nothing and never reads quality settings without searchDeps (AC7)', async () => {
        const { service: svc, create } = harness(['A', 'B'], { withSearchDeps: false });

        await expect(svc.syncDueLists()).resolves.toBeUndefined();

        expect(create).toHaveBeenCalledTimes(2);
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
      });

      it('searches nothing when searchImmediately is off, however many books were created (AC7)', async () => {
        const { service: svc, create } = harness(['A', 'B', 'C'], { searchImmediately: false });

        await svc.syncDueLists();

        expect(create).toHaveBeenCalledTimes(3);
        expect(mockRunImmediateSearch).not.toHaveBeenCalled();
      });

      it('gives duplicate, owned-race and review-held items no chain slot (AC7)', async () => {
        const { service: svc, create, findDuplicate } = harness(['Fresh', 'Dup', 'Held', 'Race']);
        findDuplicate.mockImplementation(async (candidate: { title: string }) => {
          if (candidate.title === 'Dup') return { verdict: 'same-recording', book: { id: 901, title: 'Dup' } };
          if (candidate.title === 'Held') return { verdict: 'review', book: { id: 902, title: 'Held' }, hasIncumbent: true };
          return { verdict: 'different-recording', book: null };
        });
        create.mockImplementation(async (data: { title: string }) => {
          if (data.title === 'Race') {
            throw new OwnedRecordingError({ existingBookId: 903, title: 'Race', reason: 'asin-owned' });
          }
          return createdBook(1, data.title);
        });
        mockRunImmediateSearch.mockResolvedValue(undefined);

        await svc.syncDueLists();

        expect(titleOf(mockRunImmediateSearch)).toEqual(['Fresh']);
      });

      it('gives an empty/whitespace-titled item no chain slot (AC7)', async () => {
        const provider = {
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Real Book', author: 'Author' },
            { title: '   ', author: 'Ghost' },
          ]),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(provider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList()]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const create = vi.fn().mockImplementation(async (data: { title: string }) => createdBook(1, data.title));
        mockRunImmediateSearch.mockResolvedValue(undefined);
        const svc = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined,
          makeSearchDeps({ searchImmediately: true }),
        );

        await svc.syncDueLists();

        expect(titleOf(mockRunImmediateSearch)).toEqual(['Real Book']);
      });

      it('keeps the single-flight bound across every due list in one tick (AC8)', async () => {
        const trace: string[] = [];
        const nytProvider = {
          fetchItems: vi.fn().mockImplementation(async () => {
            trace.push('fetch:A');
            return [{ title: 'A1', author: 'Author A' }];
          }),
          test: vi.fn(),
        };
        const hardcoverProvider = {
          fetchItems: vi.fn().mockImplementation(async () => {
            trace.push('fetch:B');
            return [{ title: 'B1', author: 'Author B' }];
          }),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(nytProvider);
        mockFactories.hardcover!.mockReturnValue(hardcoverProvider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([
          dueNytList({ id: 1, name: 'List A' }),
          {
            id: 2, name: 'List B', type: 'hardcover', enabled: true,
            settings: { apiKey: 'key', listType: 'trending' },
            syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
            lastSyncError: null, createdAt: new Date(),
          },
        ]));
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        const gates = new Map([['A1', deferred()], ['B1', deferred()]]);
        mockRunImmediateSearch.mockImplementation(async (book: { title: string }) => {
          trace.push(`start:${book.title}`);
          await gates.get(book.title)!.promise;
          trace.push(`end:${book.title}`);
        });

        let id = 1;
        const create = vi.fn().mockImplementation(async (data: { title: string }) => createdBook(id++, data.title));
        const svc = new ImportListService(
          inject<Db>(db), mockLog, makeBookService({ create }), undefined,
          makeSearchDeps({ searchImmediately: true }),
        );

        const sync = svc.syncDueLists();
        await flush();
        expect(trace).toEqual(['fetch:A', 'start:A1']);

        gates.get('A1')!.resolve();
        await flush();
        expect(trace).toEqual(['fetch:A', 'start:A1', 'end:A1', 'fetch:B', 'start:B1']);

        gates.get('B1')!.resolve();
        await sync;
        expect(trace).toEqual(['fetch:A', 'start:A1', 'end:A1', 'fetch:B', 'start:B1', 'end:B1']);
      });

      it('holds the import-list-sync task guard for the whole chain, so the next tick skips (AC9)', async () => {
        const { service: svc, provider } = harness(['A']);
        const gate = deferred();
        mockRunImmediateSearch.mockImplementation(async () => { await gate.promise; });

        const registry = new TaskRegistry();
        registry.register('import-list-sync', 'cron', () => svc.syncDueLists());

        const first = registry.executeTracked('import-list-sync');
        await flush();
        expect(provider.fetchItems).toHaveBeenCalledTimes(1);
        expect(registry.getAll().find((t) => t.name === 'import-list-sync')!.running).toBe(true);

        await registry.executeTracked('import-list-sync');
        expect(provider.fetchItems).toHaveBeenCalledTimes(1);

        gate.resolve();
        await first;
        expect(registry.getAll().find((t) => t.name === 'import-list-sync')!.running).toBe(false);
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

    describe('runNow — the manual per-list run (#2306)', () => {
      // Only `Date` is faked: the concurrency cases below gate on real `setImmediate` through
      // `flush()`, which a full timer fake would stall.
      beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW_MS }); });
      afterEach(() => { vi.useRealTimers(); });

      interface ManualSetup {
        service: ImportListService;
        db: ReturnType<typeof createMockDb>;
        provider: { fetchItems: ReturnType<typeof vi.fn>; test: ReturnType<typeof vi.fn> };
        updateChain: ReturnType<typeof mockDbChain>;
        create: ReturnType<typeof vi.fn>;
        findDuplicate: ReturnType<typeof vi.fn>;
        qualityGet: ReturnType<typeof vi.fn> | undefined;
      }

      function setup(opts: {
        items?: { title: string; author?: string }[];
        list?: Record<string, unknown>;
        providerError?: Error;
        create?: ReturnType<typeof vi.fn>;
        findDuplicate?: ReturnType<typeof vi.fn>;
        withSearchDeps?: boolean;
        searchImmediately?: boolean;
      } = {}): ManualSetup {
        const provider = {
          fetchItems: opts.providerError
            ? vi.fn().mockRejectedValue(opts.providerError)
            : vi.fn().mockResolvedValue(opts.items ?? []),
          test: vi.fn(),
        };
        mockFactories.nyt!.mockReturnValue(provider);

        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([dueNytList(opts.list)]));
        db.insert.mockReturnValue(mockDbChain([]));
        const updateChain = mockDbChain([]);
        db.update.mockReturnValue(updateChain);

        let nextId = 1;
        const create = opts.create
          ?? vi.fn().mockImplementation(async (data: { title: string }) => createdBook(nextId++, data.title));
        const findDuplicate = opts.findDuplicate
          ?? vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null });
        const searchDeps = opts.withSearchDeps === false
          ? undefined
          : makeSearchDeps({ searchImmediately: opts.searchImmediately ?? false });

        return {
          service: new ImportListService(
            inject<Db>(db), mockLog, makeBookService({ create, findDuplicate }), undefined, searchDeps,
          ),
          db,
          provider,
          updateChain,
          create,
          findDuplicate,
          qualityGet: searchDeps
            ? (searchDeps.settingsService.get as unknown as ReturnType<typeof vi.fn>)
            : undefined,
        };
      }

      it('syncs a list whose nextRunAt is still in the future, and touches no other provider', async () => {
        const { service: svc, provider } = setup({
          items: [{ title: 'Manual Book', author: 'Manual Author' }],
          list: { id: 9, nextRunAt: new Date(NOW_MS + 60 * 60_000) },
        });

        const outcome = await svc.runNow(9);

        expect(outcome).toEqual({ status: 'ok', counts: { createdCount: 1, heldReviewCount: 0, excludedCount: 0 } });
        expect(provider.fetchItems).toHaveBeenCalledTimes(1);
        expect(mockFactories.nyt).toHaveBeenCalledWith({ apiKey: 'key', list: 'audio-fiction' });
        expect(mockFactories.hardcover).not.toHaveBeenCalled();
      });

      it('syncs a disabled list and leaves `enabled` out of the write payload (Decision 3)', async () => {
        const { service: svc, provider, updateChain } = setup({
          items: [{ title: 'Disabled List Book', author: 'A' }],
          list: { id: 4, enabled: false },
        });

        const outcome = await svc.runNow(4);

        expect(outcome).toMatchObject({ status: 'ok' });
        expect(provider.fetchItems).toHaveBeenCalledTimes(1);
        const setCall = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
        expect(setCall).not.toHaveProperty('enabled');
      });

      it('decrypts the stored settings before dispatching the provider', async () => {
        const encryptedApiKey = encrypt('real-api-key', getKey());
        const { service: svc } = setup({
          list: { id: 12, settings: { apiKey: encryptedApiKey, list: 'audio-fiction' } },
        });

        await svc.runNow(12);

        expect(mockFactories.nyt).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: 'real-api-key' }),
        );
      });

      it('returns null for an unknown id, writing nothing and calling no provider', async () => {
        const db = createMockDb();
        db.select.mockReturnValue(mockDbChain([]));
        const svc = new ImportListService(inject<Db>(db), mockLog, makeBookService());

        const outcome = await svc.runNow(404);

        expect(outcome).toBeNull();
        expect(db.update).not.toHaveBeenCalled();
        expect(mockFactories.nyt).not.toHaveBeenCalled();
      });

      describe('AC2 — the bookkeeping is single-homed', () => {
        /** Run the same fixture down the scheduled path and the manual path; return both payloads. */
        async function bothPayloads(opts: { providerError?: Error } = {}) {
          const scheduled = setup({ list: { id: 5, syncIntervalMinutes: 60 }, ...opts });
          await scheduled.service.syncDueLists();
          const scheduledSet = scheduled.updateChain.set.mock.calls[0]![0] as Record<string, unknown>;

          const manual = setup({ list: { id: 5, syncIntervalMinutes: 60 }, ...opts });
          await manual.service.runNow(5);
          const manualSet = manual.updateChain.set.mock.calls[0]![0] as Record<string, unknown>;

          return { scheduledSet, manualSet };
        }

        it('writes the same success payload on both paths', async () => {
          const { scheduledSet, manualSet } = await bothPayloads();

          expect(manualSet).toEqual(scheduledSet);
          expect(manualSet).toEqual({
            lastRunAt: new Date(NOW_MS),
            nextRunAt: new Date(NOW_MS + 60 * 60_000),
            lastSyncError: null,
          });
        });

        it('writes the same failure payload on both paths', async () => {
          const { scheduledSet, manualSet } = await bothPayloads({ providerError: new Error('Provider down') });

          expect(manualSet).toEqual(scheduledSet);
          expect(manualSet).toEqual({
            lastSyncError: 'Provider down',
            nextRunAt: new Date(NOW_MS + 60 * 60_000),
          });
          expect(manualSet).not.toHaveProperty('lastRunAt');
        });

        it('filters the write to the run list on both paths', async () => {
          const scheduled = setup({ list: { id: 5 } });
          await scheduled.service.syncDueLists();
          const manual = setup({ list: { id: 5 } });
          await manual.service.runNow(5);

          expect(manual.updateChain.where.mock.calls[0]![0])
            .toEqual(scheduled.updateChain.where.mock.calls[0]![0]);
        });
      });

      describe('AC5 — the import-list-sync task guard admits one run at a time', () => {
        /** Both entry points share one service and one provider, so a second sync is a second fetch. */
        function gatedRegistry() {
          const harnessed = setup({ items: [{ title: 'Gated Book', author: 'A' }] });
          const gate = deferred();
          harnessed.provider.fetchItems.mockImplementation(async () => { await gate.promise; return []; });
          const registry = new TaskRegistry();
          registry.register('import-list-sync', 'cron', () => harnessed.service.syncDueLists());
          return { ...harnessed, gate, registry };
        }

        it('refuses a manual run while the cron cycle holds the task, and never syncs', async () => {
          const { service: svc, provider, gate, registry } = gatedRegistry();

          const cycle = registry.executeTracked('import-list-sync');
          await flush();
          expect(provider.fetchItems).toHaveBeenCalledTimes(1);

          const err = await registry
            .runExclusive('import-list-sync', () => svc.runNow(1))
            .catch((e: unknown) => e);

          expect(err).toBeInstanceOf(TaskRegistryError);
          expect((err as TaskRegistryError).code).toBe('ALREADY_RUNNING');
          expect(provider.fetchItems).toHaveBeenCalledTimes(1);

          gate.resolve();
          await cycle;
        });

        it('silently skips a cron tick that arrives while a manual run holds the task', async () => {
          const { service: svc, provider, gate, registry } = gatedRegistry();

          const manualRun = registry.runExclusive('import-list-sync', () => svc.runNow(1));
          await flush();
          expect(provider.fetchItems).toHaveBeenCalledTimes(1);

          await expect(registry.executeTracked('import-list-sync')).resolves.toBeUndefined();
          expect(provider.fetchItems).toHaveBeenCalledTimes(1);

          gate.resolve();
          await expect(manualRun).resolves.toMatchObject({ status: 'ok' });
        });
      });

      describe('boundaries and transient state', () => {
        it('reports an all-zero ok outcome and still clears a stale lastSyncError for an empty fetch', async () => {
          const { service: svc, updateChain } = setup({ items: [], list: { id: 6, lastSyncError: 'old error' } });

          const outcome = await svc.runNow(6);

          expect(outcome).toEqual({ status: 'ok', counts: { createdCount: 0, heldReviewCount: 0, excludedCount: 0 } });
          const setCall = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
          expect(setCall.lastSyncError).toBeNull();
          expect(setCall.lastRunAt).toEqual(new Date(NOW_MS));
        });

        it('counts a review-held duplicate without creating a book', async () => {
          const findDuplicate = vi.fn().mockResolvedValue({ verdict: 'review', book: { id: 77, title: 'Ambiguous' } });
          const create = vi.fn();
          const { service: svc } = setup({ items: [{ title: 'Ambiguous', author: 'A' }], findDuplicate, create });

          const outcome = await svc.runNow(1);

          expect(outcome).toEqual({ status: 'ok', counts: { createdCount: 0, heldReviewCount: 1, excludedCount: 0 } });
          expect(create).not.toHaveBeenCalled();
        });

        it('skips a whitespace-only title without consuming a count', async () => {
          const { service: svc, create } = setup({
            items: [{ title: '   ', author: 'Nobody' }, { title: 'Real Book', author: 'A' }],
          });

          const outcome = await svc.runNow(1);

          expect(outcome).toEqual({ status: 'ok', counts: { createdCount: 1, heldReviewCount: 0, excludedCount: 0 } });
          expect(create).toHaveBeenCalledTimes(1);
          expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Real Book' }));
        });

        it('completes without searchDeps, reading no quality settings and running no search', async () => {
          const { service: svc, qualityGet } = setup({
            items: [{ title: 'No Search Deps', author: 'A' }],
            withSearchDeps: false,
          });

          const outcome = await svc.runNow(1);

          expect(outcome).toMatchObject({ status: 'ok' });
          expect(qualityGet).toBeUndefined();
          expect(mockRunImmediateSearch).not.toHaveBeenCalled();
        });
      });

      describe('error isolation', () => {
        it('returns a failed outcome and persists failure parity when the provider throws', async () => {
          const { service: svc, updateChain } = setup({
            providerError: new Error('Connection timeout'),
            list: { id: 3, syncIntervalMinutes: 30 },
          });

          const outcome = await svc.runNow(3);

          expect(outcome).toEqual({ status: 'failed', message: 'Connection timeout' });
          const setCall = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
          expect(setCall.lastSyncError).toBe('Connection timeout');
          expect(setCall).not.toHaveProperty('lastRunAt');
          expect(setCall.nextRunAt).toEqual(new Date(NOW_MS + 30 * 60_000));
        });

        // The new rate-limit exhaustion error is an ordinary ImportListError, so the
        // persisted-vs-transient split must not change shape for it (#2537 AC2).
        describe('a Hardcover rate-limit exhaustion (#2537)', () => {
          const EXHAUSTED =
            'Hardcover API returned 429: Too Many Requests (rate limited; gave up after 3 attempts)';

          function hardcoverSetup(providers: Array<{ fetchItems: ReturnType<typeof vi.fn> }>) {
            for (const provider of providers) {
              mockFactories.hardcover!.mockReturnValueOnce({ ...provider, test: vi.fn() });
            }
            const db = createMockDb();
            db.select.mockReturnValue(mockDbChain([dueNytList({
              id: 7, name: 'Throttled Hardcover', type: 'hardcover',
              settings: { apiKey: 'key', listType: 'trending' },
              syncIntervalMinutes: 30,
            })]));
            db.insert.mockReturnValue(mockDbChain([]));
            const updateChain = mockDbChain([]);
            db.update.mockReturnValue(updateChain);
            return {
              service: new ImportListService(inject<Db>(db), mockLog, makeBookService(), undefined, makeSearchDeps()),
              updateChain,
            };
          }

          it('records the exhaustion message and still advances nextRunAt by one interval', async () => {
            const { service: svc, updateChain } = hardcoverSetup([
              { fetchItems: vi.fn().mockRejectedValue(new ImportListError('Hardcover', EXHAUSTED)) },
            ]);

            const outcome = await svc.runNow(7);

            expect(outcome).toEqual({ status: 'failed', message: EXHAUSTED });
            const setCall = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
            expect(setCall.lastSyncError).toBe(EXHAUSTED);
            expect(setCall.nextRunAt).toEqual(new Date(NOW_MS + 30 * 60_000));
          });

          it('clears lastSyncError on the next successful sync', async () => {
            const { service: svc, updateChain } = hardcoverSetup([
              { fetchItems: vi.fn().mockRejectedValue(new ImportListError('Hardcover', EXHAUSTED)) },
              { fetchItems: vi.fn().mockResolvedValue([]) },
            ]);

            await svc.runNow(7);
            const recovered = await svc.runNow(7);

            expect(recovered).toMatchObject({ status: 'ok' });
            const setCall = updateChain.set.mock.calls[1]![0] as Record<string, unknown>;
            expect(setCall.lastSyncError).toBeNull();
          });
        });

        it('logs the caught error serialized, not the derived message string', async () => {
          const cause = new Error('socket hang up');
          const { service: svc } = setup({
            providerError: new Error('Connection timeout', { cause }),
            list: { id: 3, name: 'Failing NYT' },
          });

          await svc.runNow(3);

          expect(mockLog.error).toHaveBeenCalledWith(
            expect.objectContaining({
              id: 3,
              name: 'Failing NYT',
              error: expect.objectContaining({
                message: 'Connection timeout',
                type: 'Error',
                stack: expect.stringContaining('Connection timeout'),
                cause: expect.objectContaining({ message: 'socket hang up' }),
              }),
            }),
            'Import list sync failed',
          );
        });

        it('contains a per-item failure and still reports ok', async () => {
          const create = vi.fn()
            .mockRejectedValueOnce(new Error('Item exploded'))
            .mockImplementationOnce(async (data: { title: string }) => createdBook(2, data.title));
          const { service: svc } = setup({
            items: [{ title: 'Boom', author: 'A' }, { title: 'Fine', author: 'B' }],
            create,
          });

          const outcome = await svc.runNow(1);

          expect(outcome).toEqual({ status: 'ok', counts: { createdCount: 1, heldReviewCount: 0, excludedCount: 0 } });
          expect(mockLog.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              title: 'Boom',
              error: expect.objectContaining({ message: 'Item exploded', type: 'Error' }),
            }),
            'Failed to process import list item',
          );
        });
      });
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

/**
 * AC6 — an excluded item is reported distinguishably. `syncDueLists` returns void and `syncList` is
 * private, so the counters are observed on the completion log, as the existing count tests do.
 */
describe('ImportListService — import-list exclusions (#2305)', () => {
  const dueList = (overrides: Record<string, unknown> = {}) => ({
    id: 1, name: 'My NYT', type: 'nyt', enabled: true,
    settings: { apiKey: 'key', list: 'audio-fiction' },
    syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
    lastSyncError: null, createdAt: new Date(),
    ...overrides,
  });

  const madeBook = (id: number, title: string): BookWithAuthor => ({
    id, publicId: 'bk_test', title,
    subtitle: null, description: null, publisher: null, coverUrl: null,
    asin: null, isbn: null, seriesName: null, seriesPosition: null,
    duration: null, publishedDate: null, genres: null,
    status: 'wanted', enrichmentStatus: 'pending', productionType: 'unknown', editionLabel: null,
    enrichmentAttempts: 0, path: null, size: null,
    audioCodec: null, audioBitrate: null, audioSampleRate: null,
    audioChannels: null, audioBitrateMode: null, audioFileFormat: null,
    audioFileCount: null, topLevelAudioFileCount: null, audioTotalSize: null,
    audioDuration: null, lastGrabGuid: null, lastGrabInfoHash: null,
    importListId: null, createdAt: new Date(), updatedAt: new Date(),
    authors: [], narrators: [], importListName: null,
  });

  /** `syncList`'s first act is `decryptRow` → `getKey()`; without a key the per-list catch swallows
   * the throw and the sync reads as a legitimately empty run (#2311). */
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunImmediateSearch.mockReset();
    mockSearchAndGrabForBook.mockReset();
    _resetKey();
    initializeKey(randomBytes(32));
  });

  function setup(opts: {
    items: { title: string; author?: string }[];
    isExcluded: ReturnType<typeof vi.fn>;
    recordAdded?: ReturnType<typeof vi.fn>;
    findDuplicate?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    searchImmediately?: boolean;
    list?: Record<string, unknown>;
  }) {
    mockFactories.nyt!.mockReturnValue({ fetchItems: vi.fn().mockResolvedValue(opts.items), test: vi.fn() });

    const db = createMockDb();
    db.select.mockReturnValue(mockDbChain([dueList(opts.list)]));
    db.insert.mockReturnValue(mockDbChain([]));
    db.update.mockReturnValue(mockDbChain([]));

    const create = opts.create ?? vi.fn().mockResolvedValue(madeBook(70, 'Fresh Book'));
    const bookService = makeBookService({
      ...(opts.findDuplicate && { findDuplicate: opts.findDuplicate }),
      create,
    });
    const recordAdded = opts.recordAdded ?? vi.fn().mockResolvedValue({ row: { id: 900 }, inserted: true });
    const exclusions = inject<ImportListExclusionService>({ isExcluded: opts.isExcluded, recordAdded });
    const searchDeps = opts.searchImmediately === undefined
      ? undefined
      : makeSearchDeps({ searchImmediately: opts.searchImmediately });

    const service = new ImportListService(
      inject<Db>(db), mockLog, bookService, undefined, searchDeps, exclusions,
    );
    return { service, create, exclusions, recordAdded };
  }

  it('does not create an excluded book and reports excludedCount on the completion log', async () => {
    const { service, create } = setup({
      items: [{ title: 'Excluded Book', author: 'Author One' }],
      isExcluded: vi.fn().mockResolvedValue({ id: 42, kind: 'deleted' }),
    });

    await service.syncDueLists();

    expect(create).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, createdCount: 0, heldReviewCount: 0, excludedCount: 1 }),
      'Import list sync completed',
    );
  });

  it('reports zero excludedCount when the exclusion table matches nothing', async () => {
    const { service, create } = setup({
      items: [{ title: 'Fresh Book', author: 'Author One' }],
      isExcluded: vi.fn().mockResolvedValue(null),
    });

    await service.syncDueLists();

    expect(create).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 1, heldReviewCount: 0, excludedCount: 0 }),
      'Import list sync completed',
    );
  });

  it('buckets an added-kind refusal as a skip, leaving every counter at zero (#2530)', async () => {
    const { service, create } = setup({
      items: [{ title: 'Already Added', author: 'Author One' }],
      isExcluded: vi.fn().mockResolvedValue({ id: 42, kind: 'added' }),
    });

    await service.syncDueLists();

    // Exactly what `findDuplicate` used to report for this item, so the sync line and the card
    // toast keep their present meaning.
    expect(create).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 0, heldReviewCount: 0, excludedCount: 0 }),
      'Import list sync completed',
    );
  });

  it('records the add for a created item, with the list name snapshot (#2530)', async () => {
    const { service, recordAdded } = setup({
      items: [{ title: 'Fresh Book', author: 'Author One' }],
      isExcluded: vi.fn().mockResolvedValue(null),
    });

    await service.syncDueLists();

    expect(recordAdded).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fresh Book', authorName: 'Author One' }),
      { importListId: 1, importListName: 'My NYT' },
    );
  });

  it('keeps an added refusal and a deleted refusal in different buckets in one batch (#2530)', async () => {
    const { service } = setup({
      items: [
        { title: 'Fresh Book', author: 'Author One' },
        { title: 'Already Added', author: 'Author Two' },
        { title: 'Deleted Book', author: 'Author Three' },
        { title: 'Held Book', author: 'Author Four' },
      ],
      isExcluded: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 42, kind: 'added' })
        .mockResolvedValueOnce({ id: 43, kind: 'deleted' })
        .mockResolvedValue(null),
      findDuplicate: vi.fn()
        .mockResolvedValueOnce({ verdict: 'different-recording', book: null, hasIncumbent: false })
        .mockResolvedValue({ verdict: 'review', book: { id: 555, title: 'Owned' }, hasIncumbent: true }),
    });

    await service.syncDueLists();

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 1, heldReviewCount: 1, excludedCount: 1 }),
      'Import list sync completed',
    );
  });

  it('keeps the three counters disjoint across an excluded, a held and a created item', async () => {
    const { service } = setup({
      items: [
        { title: 'Excluded Book', author: 'Author One' },
        { title: 'Held Book', author: 'Author Two' },
        { title: 'Fresh Book', author: 'Author Three' },
      ],
      isExcluded: vi.fn()
        .mockResolvedValueOnce({ id: 42, kind: 'deleted' })
        .mockResolvedValue(null),
      findDuplicate: vi.fn()
        .mockResolvedValueOnce({ verdict: 'review', book: { id: 555, title: 'Owned' }, hasIncumbent: true })
        .mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
    });

    await service.syncDueLists();

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 1, heldReviewCount: 1, excludedCount: 1 }),
      'Import list sync completed',
    );
  });

  it('still skips an empty-title item and miscounts neither it nor the excluded one', async () => {
    const { service } = setup({
      items: [{ title: '   ' }, { title: 'Excluded Book', author: 'Author One' }],
      isExcluded: vi.fn().mockResolvedValue({ id: 42, kind: 'deleted' }),
    });

    await service.syncDueLists();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 1 }),
      'Skipping item with empty/null title',
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 0, heldReviewCount: 0, excludedCount: 1 }),
      'Import list sync completed',
    );
  });

  it('does not retroactively re-count an item when the exclusion is removed mid-batch', async () => {
    // The gate reads once per item, so removing the exclusion between items changes only the
    // items still to come.
    const { service } = setup({
      items: [
        { title: 'Excluded Book', author: 'Author One' },
        { title: 'Fresh Book', author: 'Author Two' },
      ],
      isExcluded: vi.fn().mockResolvedValueOnce({ id: 42, kind: 'deleted' }).mockResolvedValue(null),
    });

    await service.syncDueLists();

    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 1, heldReviewCount: 0, excludedCount: 1 }),
      'Import list sync completed',
    );
  });

  it('contributes nothing to the immediate-search batch for an excluded item', async () => {
    const { service } = setup({
      items: [
        { title: 'Excluded Book', author: 'Author One' },
        { title: 'Fresh Book', author: 'Author Two' },
      ],
      isExcluded: vi.fn().mockResolvedValueOnce({ id: 42, kind: 'deleted' }).mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(madeBook(70, 'Fresh Book')),
      searchImmediately: true,
    });

    await service.syncDueLists();

    expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1);
    expect(mockRunImmediateSearch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 70, title: 'Fresh Book' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('contains an exclusion-read failure to its own item and still creates the other', async () => {
    const { service, create } = setup({
      items: [
        { title: 'Broken Read', author: 'Author One' },
        { title: 'Fresh Book', author: 'Author Two' },
      ],
      isExcluded: vi.fn()
        .mockRejectedValueOnce(new Error('exclusions table locked'))
        .mockResolvedValue(null),
    });

    await service.syncDueLists();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        listId: 1,
        title: 'Broken Read',
        error: expect.objectContaining({ message: 'exclusions table locked', type: 'Error' }),
      }),
      'Failed to process import list item',
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 1, excludedCount: 0 }),
      'Import list sync completed',
    );
  });

  it('gates every list, not just the one that recorded the exclusion', async () => {
    const isExcluded = vi.fn().mockResolvedValue({ id: 42, kind: 'deleted' });
    const { service } = setup({
      items: [{ title: 'Excluded Book', author: 'Author One' }],
      isExcluded,
      list: { id: 77, name: 'A Different Hardcover List', type: 'hardcover', settings: { apiKey: 'k' } },
    });
    mockFactories.hardcover!.mockReturnValue({
      fetchItems: vi.fn().mockResolvedValue([{ title: 'Excluded Book', author: 'Author One' }]),
      test: vi.fn(),
    });

    await service.syncDueLists();

    expect(isExcluded).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Excluded Book', authorName: 'Author One' }),
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ id: 77, excludedCount: 1 }),
      'Import list sync completed',
    );
  });

  it('behaves byte-identically to today when no exclusion service is wired', async () => {
    mockFactories.nyt!.mockReturnValue({
      fetchItems: vi.fn().mockResolvedValue([{ title: 'Fresh Book', author: 'Author One' }]),
      test: vi.fn(),
    });
    const db = createMockDb();
    db.select.mockReturnValue(mockDbChain([dueList()]));
    db.insert.mockReturnValue(mockDbChain([]));
    db.update.mockReturnValue(mockDbChain([]));
    const create = vi.fn().mockResolvedValue(madeBook(70, 'Fresh Book'));

    const service = new ImportListService(inject<Db>(db), mockLog, makeBookService({ create }));
    await service.syncDueLists();

    expect(create).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ createdCount: 1, excludedCount: 0 }),
      'Import list sync completed',
    );
  });
});
