import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { ImportListService } from './import-list.service.js';
import type { MetadataService } from './metadata.service.js';
import { initializeKey, _resetKey, encrypt, getKey } from '../utils/secret-codec.js';
import { randomBytes } from 'node:crypto';
import { mockDbChain, createMockDb, createMockLogger, inject } from '../__tests__/helpers.js';

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

const mockLog = createMockLogger() as unknown as FastifyBaseLogger;

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

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog);

      const result = await service.testConfig({
        type: 'abs',
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
      });
      expect(result).toEqual({ success: true });
      expect(mockFactories.abs).toHaveBeenCalledWith({ serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' });
    });

    it('returns failure for unknown provider type', async () => {
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog);

      const result = await service.testConfig({ type: 'unknown', settings: {} });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown provider type');
    });

    it('catches provider test errors', async () => {
      mockFactories.nyt.mockImplementation(() => { throw new Error('Bad config'); });
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog);

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

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog);

      const result = await service.preview({ type: 'nyt', settings: { apiKey: 'key', list: 'audio-fiction' } });
      expect(result.items).toHaveLength(10);
      expect(result.total).toBe(15);
    });

    it('returns empty items array when provider returns nothing', async () => {
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.hardcover.mockReturnValue(mockProvider);

      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog);

      const result = await service.preview({ type: 'hardcover', settings: { apiKey: 'key' } });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('throws for unknown provider type', async () => {
      const db = createMockDb();
      service = new ImportListService(inject<Db>(db), mockLog);

      await expect(service.preview({ type: 'unknown', settings: {} })).rejects.toThrow('Unknown provider type');
    });
  });

  describe('CRUD', () => {
    it('getAll returns all import lists', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 1, name: 'Test', type: 'abs', settings: {}, enabled: true }]));
      service = new ImportListService(inject<Db>(db), mockLog);

      const results = await service.getAll();
      expect(results).toHaveLength(1);
      expect(db.select).toHaveBeenCalled();
    });

    it('create encrypts API key and sets nextRunAt', async () => {
      const db = createMockDb();
      const insertChain = mockDbChain([{ id: 1, name: 'Test', type: 'abs', settings: { serverUrl: 'http://abs.local', apiKey: 'key' }, createdAt: new Date() }]);
      db.insert.mockReturnValue(insertChain);
      service = new ImportListService(inject<Db>(db), mockLog);

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

      // select().from().where().limit() for sentinel lookup returns existing row
      db.select.mockReturnValue(mockDbChain([existingRow]));
      // update().set().where().returning() returns updated row
      const updateChain = mockDbChain([existingRow]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog);

      await service.update(1, {
        settings: { serverUrl: 'http://new.local', apiKey: '********', libraryId: 'lib-2' },
      });

      // The .set() call must preserve the exact stored ciphertext, not re-encrypt the sentinel
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            apiKey: encryptedApiKey,
            libraryId: 'lib-2',
          }),
        }),
      );
    });

    it('delete removes row from DB', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 1, name: 'Test', type: 'abs', settings: {}, enabled: true }]));
      service = new ImportListService(inject<Db>(db), mockLog);

      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('syncDueLists', () => {
    it('skips disabled lists even if nextRunAt is past due', async () => {
      const db = createMockDb();
      // Query returns empty (no enabled due lists)
      db.select.mockReturnValue(mockDbChain([]));
      service = new ImportListService(inject<Db>(db), mockLog);

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

      const db = createMockDb();
      const dueList = {
        id: 1, name: 'My ABS', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      // Due lists query
      db.select.mockReturnValueOnce(mockDbChain([dueList]));
      // Author lookup returns empty
      db.select.mockReturnValueOnce(mockDbChain([]));
      // Book insert
      db.insert.mockReturnValue(mockDbChain([{ id: 10, title: 'New Book', authorId: null }]));
      // Update chain
      db.update.mockReturnValue(mockDbChain([]));

      service = new ImportListService(inject<Db>(db), mockLog);

      await service.syncDueLists();
      expect(mockProvider.fetchItems).toHaveBeenCalled();
    });

    it('persists lastRunAt, nextRunAt, clears lastSyncError on success', async () => {
      const mockProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createMockDb();
      const dueList = {
        id: 5, name: 'ABS List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 60, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: 'old error', createdAt: new Date(),
      };
      db.select.mockReturnValue(mockDbChain([dueList]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);
      service = new ImportListService(inject<Db>(db), mockLog);

      await service.syncDueLists();

      // Find the set() call on the success path
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toBeNull();
      expect(setCall.lastRunAt).toBeInstanceOf(Date);
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
      // nextRunAt should be ~60 minutes from now
      const diff = (setCall.nextRunAt as Date).getTime() - Date.now();
      expect(diff).toBeGreaterThan(59 * 60_000);
      expect(diff).toBeLessThan(61 * 60_000);
    });

    it('persists lastSyncError and advances nextRunAt on failure', async () => {
      const failProvider = { fetchItems: vi.fn().mockRejectedValue(new Error('Connection timeout')), test: vi.fn() };
      mockFactories.abs.mockReturnValue(failProvider);

      const db = createMockDb();
      const dueList = {
        id: 3, name: 'Failing List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      db.select.mockReturnValue(mockDbChain([dueList]));
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);
      service = new ImportListService(inject<Db>(db), mockLog);

      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toBe('Connection timeout');
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
    });

    it('inserts book with importListId and creates import_list event', async () => {
      const mockProvider = {
        fetchItems: vi.fn().mockResolvedValue([{ title: 'Import Book', author: 'Author Name' }]),
        test: vi.fn(),
      };
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createMockDb();
      const dueList = {
        id: 7, name: 'My List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      // Due lists query
      db.select.mockReturnValueOnce(mockDbChain([dueList]));
      // Author lookup — found
      db.select.mockReturnValueOnce(mockDbChain([{ id: 99, name: 'Author Name' }]));
      // Book insert
      const bookInsertChain = mockDbChain([{ id: 42, title: 'Import Book', authorId: 99 }]);
      db.insert.mockReturnValueOnce(bookInsertChain);
      // Event insert
      db.insert.mockReturnValue(mockDbChain([]));
      // Update chain
      db.update.mockReturnValue(mockDbChain([]));

      service = new ImportListService(inject<Db>(db), mockLog);

      await service.syncDueLists();

      // Book insert was attempted
      expect(db.insert).toHaveBeenCalled();
      // onConflictDoNothing was used for the book insert
      expect(bookInsertChain.onConflictDoNothing).toHaveBeenCalled();
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

      const db = createMockDb();
      const dueList = {
        id: 1, name: 'Mixed List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      // Due lists query
      db.select.mockReturnValueOnce(mockDbChain([dueList]));
      // Author lookup for Valid Book — found
      db.select.mockReturnValueOnce(mockDbChain([{ id: 50, name: 'Author' }]));
      // Book insert
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 20, title: 'Valid Book', authorId: 50 }]));
      // Event insert + update chain
      db.insert.mockReturnValue(mockDbChain([]));
      db.update.mockReturnValue(mockDbChain([]));

      service = new ImportListService(inject<Db>(db), mockLog);

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

    // #477 — enrichItem branches (tested via syncDueLists)
    describe('enrichItem via syncDueLists (#477)', () => {
      const dueList = {
        id: 1, name: 'Test List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };

      it('no metadata service — book inserted with original ASIN/author from import list item', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'My Book', author: 'Original Author', asin: 'B001' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        // Author lookup — found
        db.select.mockReturnValueOnce(mockDbChain([{ id: 1, name: 'Original Author', slug: 'original-author' }]));
        const bookInsertChain = mockDbChain([{ id: 10, title: 'My Book' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        db.insert.mockReturnValue(mockDbChain([])); // bookAuthors + bookEvents
        db.update.mockReturnValue(mockDbChain([]));

        // No metadata service passed
        service = new ImportListService(inject<Db>(db), mockLog);
        await service.syncDueLists();

        // Book inserted with original ASIN
        expect(bookInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ asin: 'B001', title: 'My Book' }),
        );
      });

      it('item already has ASIN — metadata service not called, book inserted with original ASIN', async () => {
        const mockMetadata = { search: vi.fn(), getBook: vi.fn() } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'My Book', author: 'Author', asin: 'B002' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        db.select.mockReturnValueOnce(mockDbChain([{ id: 1, name: 'Author', slug: 'author' }]));
        const bookInsertChain = mockDbChain([{ id: 10, title: 'My Book' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, mockMetadata);
        await service.syncDueLists();

        expect(mockMetadata.search).not.toHaveBeenCalled();
        expect(bookInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ asin: 'B002' }),
        );
      });

      it('metadata search returns zero results — book inserted with original ASIN unchanged', async () => {
        const mockMetadata = {
          search: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
          getBook: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Obscure Book', author: 'Nobody' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        db.select.mockReturnValueOnce(mockDbChain([{ id: 1, name: 'Nobody', slug: 'nobody' }]));
        const bookInsertChain = mockDbChain([{ id: 10, title: 'Obscure Book' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, mockMetadata);
        await service.syncDueLists();

        expect(mockMetadata.search).toHaveBeenCalled();
        // Book inserted with null ASIN (original item had none)
        expect(bookInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ asin: null }),
        );
      });

      it('metadata search match with providerId, getBook returns detail with ASIN — book inserted with detail ASIN and bookAuthors created', async () => {
        const mockMetadata = {
          search: vi.fn().mockResolvedValue({
            books: [{ asin: undefined, providerId: 'prov-123', authors: [{ name: 'Detail Author' }] }],
            authors: [], series: [],
          }),
          getBook: vi.fn().mockResolvedValue({ asin: 'B_DETAIL' }),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Book With Provider', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        // findOrCreateAuthor: existing author found
        db.select.mockReturnValueOnce(mockDbChain([{ id: 1, name: 'Author', slug: 'author' }]));
        // Book insert
        const bookInsertChain = mockDbChain([{ id: 10, title: 'Book With Provider' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        // bookAuthors insert
        const bookAuthorsChain = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookAuthorsChain);
        // bookEvents insert
        const bookEventsChain = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookEventsChain);
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, mockMetadata);
        await service.syncDueLists();

        expect(mockMetadata.getBook).toHaveBeenCalledWith('prov-123');
        expect(bookInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ asin: 'B_DETAIL' }),
        );
        // bookAuthors insert with correct author ID
        expect(bookAuthorsChain.values).toHaveBeenCalledWith({ bookId: 10, authorId: 1, position: 0 });
        // bookEvents insert with correct payload
        expect(bookEventsChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 10, eventType: 'grabbed', source: 'import_list' }),
        );
      });

      it('metadata search match with providerId, getBook returns null — book inserted with search-result ASIN', async () => {
        const mockMetadata = {
          search: vi.fn().mockResolvedValue({
            books: [{ asin: undefined, providerId: 'prov-456', authors: [{ name: 'Search Author' }] }],
            authors: [], series: [],
          }),
          getBook: vi.fn().mockResolvedValue(null),
        } as unknown as MetadataService;
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Fallback Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        db.select.mockReturnValueOnce(mockDbChain([{ id: 1, name: 'Author', slug: 'author' }]));
        const bookInsertChain = mockDbChain([{ id: 10, title: 'Fallback Book' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, mockMetadata);
        await service.syncDueLists();

        expect(mockMetadata.getBook).toHaveBeenCalledWith('prov-456');
        // ASIN is null (search result had undefined, getBook returned null)
        expect(bookInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ asin: null }),
        );
      });

      it('metadata search throws — item still processed with original values, warn logged', async () => {
        const mockMetadata = {
          search: vi.fn().mockRejectedValue(new Error('API timeout')),
          getBook: vi.fn(),
        } as unknown as MetadataService;
        const mockProvider = {
          // Item WITHOUT asin to trigger search path
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Resilient Book', author: 'Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        db.select.mockReturnValueOnce(mockDbChain([{ id: 1, name: 'Author', slug: 'author' }]));
        const bookInsertChain = mockDbChain([{ id: 10, title: 'Resilient Book' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        db.insert.mockReturnValue(mockDbChain([]));
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog, mockMetadata);
        await service.syncDueLists();

        // Metadata enrichment failure was logged at warn level
        expect(mockLog.warn).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Resilient Book' }),
          expect.stringContaining('Metadata enrichment failed'),
        );
        // Book still inserted with null ASIN (original had none)
        expect(bookInsertChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ asin: null, title: 'Resilient Book' }),
        );
      });
    });

    // #477 — findOrCreateAuthor branches (tested via syncDueLists)
    describe('findOrCreateAuthor via syncDueLists (#477)', () => {
      const dueList = {
        id: 1, name: 'Test List', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 1440, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };

      it('author does not exist — insert succeeds — bookAuthors row created with new author ID', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'New Book', author: 'New Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        // findOrCreateAuthor: initial lookup returns empty
        db.select.mockReturnValueOnce(mockDbChain([]));
        // Book insert succeeds
        const bookInsertChain = mockDbChain([{ id: 10, title: 'New Book' }]);
        db.insert.mockReturnValueOnce(bookInsertChain);
        // Author insert succeeds (new author)
        const authorInsertChain = mockDbChain([{ id: 50, name: 'New Author', slug: 'new-author' }]);
        db.insert.mockReturnValueOnce(authorInsertChain);
        // bookAuthors insert
        const bookAuthorsChain = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookAuthorsChain);
        // bookEvents insert
        const bookEventsChain = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookEventsChain);
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog);
        await service.syncDueLists();

        // bookAuthors insert uses new author ID 50
        expect(bookAuthorsChain.values).toHaveBeenCalledWith({ bookId: 10, authorId: 50, position: 0 });
        // bookEvents insert with correct payload
        expect(bookEventsChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 10, bookTitle: 'New Book', eventType: 'grabbed', source: 'import_list' }),
        );
      });

      it('race condition — insert returns empty, retry SELECT finds author — bookAuthors created with recovered ID', async () => {
        const mockProvider = {
          fetchItems: vi.fn().mockResolvedValue([{ title: 'Race Book', author: 'Race Author' }]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));
        // findOrCreateAuthor: initial lookup returns empty
        db.select.mockReturnValueOnce(mockDbChain([]));
        // Book insert succeeds
        db.insert.mockReturnValueOnce(mockDbChain([{ id: 10, title: 'Race Book' }]));
        // Author insert returns empty (onConflictDoNothing — conflict)
        db.insert.mockReturnValueOnce(mockDbChain([]));
        // Retry SELECT finds the author
        db.select.mockReturnValueOnce(mockDbChain([{ id: 77, name: 'Race Author', slug: 'race-author' }]));
        // bookAuthors insert
        const bookAuthorsChain = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookAuthorsChain);
        // bookEvents insert
        const bookEventsChain = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookEventsChain);
        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog);
        await service.syncDueLists();

        // bookAuthors insert uses recovered author ID 77
        expect(bookAuthorsChain.values).toHaveBeenCalledWith({ bookId: 10, authorId: 77, position: 0 });
        // bookEvents still written
        expect(bookEventsChain.values).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 10, bookTitle: 'Race Book', eventType: 'grabbed', source: 'import_list' }),
        );
      });

      it('race condition null — insert returns empty, retry SELECT returns empty — bookAuthors skipped, bookEvents still inserted, sync continues', async () => {
        const mockProvider = {
          // Two items: first triggers null author path, second proves sync continues
          fetchItems: vi.fn().mockResolvedValue([
            { title: 'Null Race Book', author: 'Ghost Author' },
            { title: 'Second Book', author: 'Real Author' },
          ]),
          test: vi.fn(),
        };
        mockFactories.abs.mockReturnValue(mockProvider);

        const db = createMockDb();
        db.select.mockReturnValueOnce(mockDbChain([dueList]));

        // --- Item 1: Null Race Book (ghost author path) ---
        // findOrCreateAuthor: initial lookup returns empty
        db.select.mockReturnValueOnce(mockDbChain([]));
        // Book insert succeeds
        db.insert.mockReturnValueOnce(mockDbChain([{ id: 10, title: 'Null Race Book' }]));
        // Author insert returns empty (conflict)
        db.insert.mockReturnValueOnce(mockDbChain([]));
        // Retry SELECT also returns empty (null path)
        db.select.mockReturnValueOnce(mockDbChain([]));
        // bookEvents insert for item 1 (no bookAuthors — authorId is null)
        const bookEventsChain1 = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookEventsChain1);

        // --- Item 2: Second Book (proves sync continues) ---
        // findOrCreateAuthor: found immediately
        db.select.mockReturnValueOnce(mockDbChain([{ id: 99, name: 'Real Author', slug: 'real-author' }]));
        // Book insert succeeds
        db.insert.mockReturnValueOnce(mockDbChain([{ id: 20, title: 'Second Book' }]));
        // bookAuthors insert for item 2
        const bookAuthorsChain2 = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookAuthorsChain2);
        // bookEvents insert for item 2
        const bookEventsChain2 = mockDbChain([]);
        db.insert.mockReturnValueOnce(bookEventsChain2);

        db.update.mockReturnValue(mockDbChain([]));

        service = new ImportListService(inject<Db>(db), mockLog);
        await service.syncDueLists();

        // Item 1: bookEvents written despite null author
        expect(bookEventsChain1.values).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 10, bookTitle: 'Null Race Book', eventType: 'grabbed', source: 'import_list' }),
        );
        // Item 1: bookAuthors NOT written (authorId was null)
        // The 3 inserts for item 1 are: book, author(empty), bookEvents — no bookAuthors
        // Verify by checking that item 2's bookAuthors chain IS called (proving the difference)
        expect(bookAuthorsChain2.values).toHaveBeenCalledWith({ bookId: 20, authorId: 99, position: 0 });

        // Item 2: bookEvents also written (sync continued after null path)
        expect(bookEventsChain2.values).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 20, bookTitle: 'Second Book', eventType: 'grabbed', source: 'import_list' }),
        );

        // Both items logged as added
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 10, title: 'Null Race Book' }),
          expect.stringContaining('Book added from import list'),
        );
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 20, title: 'Second Book' }),
          expect.stringContaining('Book added from import list'),
        );
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
      mockFactories.abs.mockReturnValue(mockProvider);

      const db = createMockDb();
      const dueList = {
        id: 1, name: 'Failing Items', type: 'abs', enabled: true,
        settings: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib-1' },
        syncIntervalMinutes: 60, lastRunAt: null, nextRunAt: new Date(Date.now() - 60_000),
        lastSyncError: null, createdAt: new Date(),
      };
      db.select.mockReturnValueOnce(mockDbChain([dueList]));
      // Author lookups all fail → processItem throws for each
      db.select.mockReturnValue(mockDbChain([]));
      db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('insert failed')) }) }) });
      const updateChain = mockDbChain([]);
      db.update.mockReturnValue(updateChain);

      service = new ImportListService(inject<Db>(db), mockLog);
      await service.syncDueLists();

      // Item failures are swallowed by syncList — outer syncDueLists treats it as success
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toBeNull();
      expect(setCall.lastRunAt).toBeInstanceOf(Date);
      // log.warn called for each failed item
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

      service = new ImportListService(inject<Db>(db), mockLog);
      await service.syncDueLists();

      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setCall.lastSyncError).toContain('Unknown provider type');
      expect(setCall.nextRunAt).toBeInstanceOf(Date);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Unknown Type' }),
        expect.stringContaining('sync failed'),
      );
    });

    it('isolates provider failures — one list failing does not block others', async () => {
      const failProvider = { fetchItems: vi.fn().mockRejectedValue(new Error('Provider down')), test: vi.fn() };
      const successProvider = { fetchItems: vi.fn().mockResolvedValue([]), test: vi.fn() };
      mockFactories.abs.mockReturnValue(failProvider);
      mockFactories.nyt.mockReturnValue(successProvider);

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
      // Due lists query returns both
      db.select.mockReturnValue(mockDbChain([list1, list2]));
      // Update chains for both lists
      db.update.mockReturnValue(mockDbChain([]));

      service = new ImportListService(inject<Db>(db), mockLog);

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
