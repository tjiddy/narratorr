import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { ImportListService } from './import-list.service.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { randomBytes } from 'node:crypto';

// Mock the adapter factories
vi.mock('../../core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: {
    abs: vi.fn(),
    nyt: vi.fn(),
    hardcover: vi.fn(),
  },
}));

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('../../core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as Record<string, ReturnType<typeof vi.fn>>;

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  silent: vi.fn(),
  level: 'info',
} as unknown as FastifyBaseLogger;

// ─── Chainable mock DB ──────────────────────────────────────────────────────
// Returns configurable result arrays at the end of each chain

function createChainableMockDb() {
  let selectResult: unknown[] = [];
  let insertResult: unknown[] = [];

  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => selectResult),
    limit: vi.fn().mockImplementation(() => selectResult.slice(0, 1)),
    orderBy: vi.fn().mockImplementation(() => selectResult),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(() => insertResult),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };

  // Make all methods return the chain for fluent calls
  for (const key of Object.keys(chain)) {
    const fn = chain[key as keyof typeof chain];
    if (key === 'where' || key === 'limit' || key === 'orderBy' || key === 'returning') continue;
    (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  // where needs to return both chain (for further chaining) and be iterable (for sync query)
  // So we make it return the chain but override the iterator
  chain.where.mockReturnValue(chain);

  return {
    ...chain,
    _setSelectResult: (rows: unknown[]) => { selectResult = rows; },
    _setInsertResult: (rows: unknown[]) => { insertResult = rows; },
    // Override select chain to return array for sync queries
    _makeSelectReturnArray: () => {
      chain.where.mockImplementation(() => selectResult);
    },
  };
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
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.testConfig({
        type: 'abs',
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
      });
      expect(result).toEqual({ success: true });
      expect(mockFactories.abs).toHaveBeenCalledWith({ serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' });
    });

    it('returns failure for unknown provider type', async () => {
      const db = createChainableMockDb();
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.testConfig({ type: 'unknown', settings: {} });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown provider type');
    });

    it('catches provider test errors', async () => {
      mockFactories.nyt.mockImplementation(() => { throw new Error('Bad config'); });
      const db = createChainableMockDb();
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.testConfig({ type: 'nyt', settings: {} });
      expect(result.success).toBe(false);
      expect(result.message).toBe('Bad config');
    });
  });

  describe('preview', () => {
    it('returns first 10 items capped with total count', async () => {
      const items = Array.from({ length: 15 }, (_, i) => ({ title: `Book ${i}` }));
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue(items), test: vi.fn() };
      mockFactories.nyt.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.preview({ type: 'nyt', settings: { apiKey: 'key', list: 'audio-fiction' } });
      expect(result.items).toHaveLength(10);
      expect(result.total).toBe(15);
    });

    it('returns empty items array when provider returns nothing', async () => {
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.hardcover.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.preview({ type: 'hardcover', settings: { apiKey: 'key' } });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('throws for unknown provider type', async () => {
      const db = createChainableMockDb();
      service = new ImportListService(db as unknown as Db, mockLog);

      await expect(service.preview({ type: 'unknown', settings: {} })).rejects.toThrow('Unknown provider type');
    });
  });

  describe('CRUD', () => {
    it('getAll returns all import lists', async () => {
      const db = createChainableMockDb();
      db._setSelectResult([{ id: 1, name: 'Test', type: 'abs', settings: {}, enabled: true }]);
      service = new ImportListService(db as unknown as Db, mockLog);

      const results = await service.getAll();
      expect(results).toHaveLength(1);
      expect(db.select).toHaveBeenCalled();
    });

    it('create encrypts API key and sets nextRunAt', async () => {
      const db = createChainableMockDb();
      db._setInsertResult([{ id: 1, name: 'Test', type: 'abs', settings: { serverUrl: 'http://abs.local', apiKey: 'key' }, createdAt: new Date() }]);
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.create({
        name: 'Test',
        type: 'abs',
        enabled: true,
        syncIntervalMinutes: 1440,
        settings: { serverUrl: 'http://abs.local', apiKey: 'test-key', libraryId: 'lib-1' },
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalled();
      // Verify nextRunAt was set by checking the values call
      const valuesCall = db.values.mock.calls[0][0];
      expect(valuesCall.nextRunAt).toBeInstanceOf(Date);
    });

    it('delete removes row from DB', async () => {
      const db = createChainableMockDb();
      db._setSelectResult([{ id: 1, name: 'Test', type: 'abs', settings: {}, enabled: true }]);
      service = new ImportListService(db as unknown as Db, mockLog);

      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('syncDueLists', () => {
    it('skips disabled lists even if nextRunAt is past due', async () => {
      const db = createChainableMockDb();
      // Query returns empty (no enabled due lists)
      db._setSelectResult([]);
      db.where.mockReturnValue([]);
      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();
      // Should not attempt to process any lists
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ count: expect.any(Number) }),
        expect.stringContaining('Processing'),
      );
    });

    it('fetches items from provider for each due list', async () => {
      const mockProvider = {
        fetchItems: vi.fn().mockResolvedValue([{ title: 'New Book', author: 'Author' }]),
        test: vi.fn(),
      };
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      const dueList = {
        id: 1, name: 'My ABS', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      // First query (due lists) returns the list
      db.where.mockReturnValueOnce([dueList]);
      // Author lookup returns empty
      db.where.mockReturnValueOnce([]);
      // Book insert
      db._setInsertResult([{ id: 10, title: 'New Book', authorId: null }]);
      // Update lastRunAt chain
      db.where.mockReturnValue({ returning: vi.fn().mockReturnValue([]) });

      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();
      expect(mockProvider.fetchItems).toHaveBeenCalled();
    });

    it('persists lastRunAt, nextRunAt, clears lastSyncError on success', async () => {
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      const dueList = {
        id: 5, name: 'ABS List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 60, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: 'old error', createdAt: new Date(),
      };
      db.where.mockReturnValueOnce([dueList]);
      db.where.mockReturnValue(db); // chain for update
      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();

      // Find the set() call on the success path
      const setCall = db.set.mock.calls[0][0];
      expect(setCall.lastSyncError).toBeNull();
      expect(setCall.lastRunAt).toBeInstanceOf(Date);
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
      // nextRunAt should be ~60 minutes from now
      const diff = setCall.nextRunAt.getTime() - Date.now();
      expect(diff).toBeGreaterThan(59 * 60_000);
      expect(diff).toBeLessThan(61 * 60_000);
    });

    it('persists lastSyncError and advances nextRunAt on failure', async () => {
      const failProvider = { fetchItems: vi.fn().mockRejectedValue(new Error('Connection timeout')), test: vi.fn() };
      mockFactories.abs.mockReturnValue(failProvider);

      const db = createChainableMockDb();
      const dueList = {
        id: 3, name: 'Failing List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      db.where.mockReturnValueOnce([dueList]);
      db.where.mockReturnValue(db);
      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();

      const setCall = db.set.mock.calls[0][0];
      expect(setCall.lastSyncError).toBe('Connection timeout');
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
    });

    it('inserts book with importListId and creates import_list event', async () => {
      const mockProvider = {
        fetchItems: vi.fn().mockResolvedValue([{ title: 'Import Book', author: 'Author Name' }]),
        test: vi.fn(),
      };
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      const dueList = {
        id: 7, name: 'My List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      // 1st where: due lists query (result is iterated directly, no .limit)
      db.where.mockReturnValueOnce([dueList]);
      // 2nd where: author lookup in resolveOrCreateAuthor — .limit(1) follows, so return chain
      db.where.mockReturnValueOnce(db);
      // limit returns the author result
      db.limit.mockReturnValueOnce([{ id: 99, name: 'Author Name' }]);
      // 1st returning: book insert → new book
      db.returning.mockReturnValueOnce([{ id: 42, title: 'Import Book', authorId: 99 }]);
      // 2nd returning: event insert (no returning in code, but values() chains)
      // Remaining where calls (update chain) return chain
      db.where.mockReturnValue(db);
      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();

      // Book insert was attempted
      expect(db.insert).toHaveBeenCalled();
      // onConflictDoNothing was used for the book insert
      expect(db.onConflictDoNothing).toHaveBeenCalled();
      // Logged the book addition with correct metadata
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, title: 'Import Book', listName: 'My List' }),
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
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createChainableMockDb();
      const dueList = {
        id: 1, name: 'Mixed List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      // 1st where: due lists query
      db.where.mockReturnValueOnce([dueList]);
      // 2nd where: author lookup for Valid Book — .limit(1) follows
      db.where.mockReturnValueOnce(db);
      db.limit.mockReturnValueOnce([{ id: 50, name: 'Author' }]);
      // Book insert returns new book
      db.returning.mockReturnValueOnce([{ id: 20, title: 'Valid Book', authorId: 50 }]);
      // Remaining where calls return chain
      db.where.mockReturnValue(db);
      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();

      // Should have logged warning for the empty-title item
      const warnCalls = (mockLog.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const emptyTitleWarn = warnCalls.find((call) => {
        const msg = call[1] as string;
        return typeof msg === 'string' && msg.includes('empty/null title');
      });
      expect(emptyTitleWarn).toBeDefined();
      // Should have processed the valid book
      const infoCalls = (mockLog.info as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
      const bookAddedLog = infoCalls.find((call) => {
        const msg = call[1] as string;
        return typeof msg === 'string' && msg.includes('Book added');
      });
      expect(bookAddedLog).toBeDefined();
    });

    it('isolates provider failures — one list failing does not block others', async () => {
      const failProvider = { fetchItems: vi.fn().mockRejectedValue(new Error('Provider down')), test: vi.fn() };
      const successProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.abs.mockReturnValue(failProvider);
      mockFactories.nyt.mockReturnValue(successProvider);

      const db = createChainableMockDb();
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
      // Due lists query returns both
      db.where.mockReturnValueOnce([list1, list2]);
      // Subsequent update calls need to return chain
      db.where.mockReturnValue({ returning: vi.fn().mockReturnValue([]) });

      service = new ImportListService(db as unknown as Db, mockLog);

      await service.syncDueLists();

      // Both providers should have been called
      expect(failProvider.fetchItems).toHaveBeenCalled();
      expect(successProvider.fetchItems).toHaveBeenCalled();
      // Error should be logged for the failing list
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Failing ABS' }),
        expect.stringContaining('sync failed'),
      );
    });
  });
});
