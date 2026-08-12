import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';

import { BookService, CoverUploadError } from './book.service.js';
import { serializeError } from '../utils/serialize-error.js';
import { buildBookCreatePayload } from './enrichment-orchestration.helpers.js';
import type { ProductionType } from '@shared/schemas/book.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { eq } from 'drizzle-orm';
import { authors, books, series, seriesMembers } from '@db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';
import type { MetadataService } from './metadata.service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    rm: vi.fn(),
    rmdir: vi.fn(),
    readdir: vi.fn(),
    // Preserve real stat outside deleteBookFiles; that suite overrides it (#1589).
    stat: vi.fn((...args: unknown[]) => (actual.stat as (...a: unknown[]) => unknown)(...args)),
    // lstat is deliberate: managed deletion must never follow a symlinked source (#1598).
    lstat: vi.fn((...args: unknown[]) => (actual.lstat as (...a: unknown[]) => unknown)(...args)),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
  };
});

import { rm, rmdir, readdir, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import type { Mock } from 'vitest';

const mockAuthor = createMockDbAuthor();
const mockBook = createMockDbBook();
const mockNarrator = { id: 1, name: 'Michael Kramer', slug: 'michael-kramer', createdAt: new Date('2024-01-01T00:00:00Z') };

/** getById selects the book, authors, then narrators. */
function setupGetById(db: ReturnType<typeof createMockDb>, opts?: {
  noNarrators?: boolean;
  importListName?: string | null;
}) {
  db.select
    .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: opts?.importListName ?? null }]))
    .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
    .mockReturnValueOnce(mockDbChain(opts?.noNarrators ? [] : [{ narrator: mockNarrator, position: 0 }]));
}

describe('BookService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('getById', () => {
    it('returns book with authors and narrators arrays', async () => {
      setupGetById(db);

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
      expect(result!.authors).toHaveLength(1);
      expect(result!.authors[0]!.name).toBe('Brandon Sanderson');
      expect(result!.narrators).toHaveLength(1);
      expect(result!.narrators[0]!.name).toBe('Michael Kramer');
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });

    it('returns narrators: [] (not null) when book has no narrators', async () => {
      setupGetById(db, { noNarrators: true });

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.narrators).toEqual([]);
    });

    it('returns authors and narrators sorted by position', async () => {
      const author2 = { ...mockAuthor, id: 2, name: 'Second Author', slug: 'second-author' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([
          { author: author2, position: 1 },
          { author: mockAuthor, position: 0 },
        ]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getById(1);
      expect(result!.authors[0]!.name).toBe('Brandon Sanderson');
      expect(result!.authors[1]!.name).toBe('Second Author');
    });
  });

  describe('findLibraryStatusByAsins', () => {
    // BookService has no SettingsService; disabled must consume only the books select (#1961).
    const disabled = { companionEnabled: false };

    it('returns a Map keyed by UPPERCASED asin with { bookId: publicId, status, companionEbook } values', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, bookId: 'bk_abc123', status: 'imported', asin: 'B00ASIN' },
      ]));

      const map = await service.findLibraryStatusByAsins(['B00ASIN'], disabled);

      expect(map.get('B00ASIN')).toEqual({ bookId: 'bk_abc123', status: 'imported', companionEbook: null });
      expect(map.get('B00ASIN')!.bookId).toMatch(/^bk_/);
    });

    // This mock proves map-key normalization only; the DB-backed integration test proves lower(asin) (#1537).
    it('keys the map by the UPPERCASED asin even when the stored row is lowercase', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, bookId: 'bk_drift', status: 'imported', asin: 'b00asin' },
      ]));

      const map = await service.findLibraryStatusByAsins(['B00ASIN'], disabled);

      expect(map.has('B00ASIN')).toBe(true);
      expect(map.get('B00ASIN')).toEqual({ bookId: 'bk_drift', status: 'imported', companionEbook: null });
    });

    it('returns an empty map WITHOUT issuing a query for an empty input array (no IN ())', async () => {
      const map = await service.findLibraryStatusByAsins([], { companionEnabled: true });

      expect(map.size).toBe(0);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('skips a null-asin row (partial index excludes null-asin owned books)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, bookId: 'bk_null', status: 'wanted', asin: null },
      ]));

      const map = await service.findLibraryStatusByAsins(['B00ASIN'], disabled);

      expect(map.size).toBe(0);
    });

    it('resolves multiple asins in a single batch lookup (one query, not N)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, bookId: 'bk_a', status: 'imported', asin: 'B00AAA' },
        { id: 2, bookId: 'bk_b', status: 'downloading', asin: 'B00BBB' },
      ]));

      const map = await service.findLibraryStatusByAsins(['B00AAA', 'B00BBB'], disabled);

      expect(db.select).toHaveBeenCalledTimes(1);
      expect(map.get('B00AAA')).toEqual({ bookId: 'bk_a', status: 'imported', companionEbook: null });
      expect(map.get('B00BBB')).toEqual({ bookId: 'bk_b', status: 'downloading', companionEbook: null });
    });

    // DB-backed exposure/chunking lives in the integration test; these pin query posture and mapping (#1961).
    describe('companion ebooks (#1961)', () => {
      it('maps an available observation on an imported book through toCompanionEbookV1', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ id: 7, bookId: 'bk_have', status: 'imported', asin: 'B00ASIN' }]))
          .mockReturnValueOnce(mockDbChain([{ bookId: 7, status: 'available', sizeBytes: 123456 }]));

        const map = await service.findLibraryStatusByAsins(['B00ASIN'], { companionEnabled: true });

        expect(map.get('B00ASIN')).toEqual({
          bookId: 'bk_have',
          status: 'imported',
          companionEbook: { format: 'epub', sizeBytes: 123456 },
        });
      });

      it('issues exactly TWO selects when enabled (books + one companion chunk)', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ id: 7, bookId: 'bk_have', status: 'imported', asin: 'B00ASIN' }]))
          .mockReturnValueOnce(mockDbChain([{ bookId: 7, status: 'available', sizeBytes: 1 }]));

        await service.findLibraryStatusByAsins(['B00ASIN'], { companionEnabled: true });

        expect(db.select).toHaveBeenCalledTimes(2);
      });

      it('issues NO companion query when disabled — one select, every value null (AC 15)', async () => {
        db.select.mockReturnValueOnce(mockDbChain([
          { id: 7, bookId: 'bk_have', status: 'imported', asin: 'B00ASIN' },
        ]));

        const map = await service.findLibraryStatusByAsins(['B00ASIN'], disabled);

        expect(db.select).toHaveBeenCalledTimes(1);
        expect(map.get('B00ASIN')!.companionEbook).toBeNull();
      });

      it('carries companionEbook: null (key present) for a matched book with no observation row', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ id: 7, bookId: 'bk_have', status: 'imported', asin: 'B00ASIN' }]))
          .mockReturnValueOnce(mockDbChain([]));

        const map = await service.findLibraryStatusByAsins(['B00ASIN'], { companionEnabled: true });

        expect(map.get('B00ASIN')!.companionEbook).toBeNull();
        expect(Object.keys(map.get('B00ASIN')!)).toContain('companionEbook');
      });

      // The DB constraint rejects available + null size, so only a mock can cover the typed unreachable case.
      it('round-trips sizeBytes: 0 as 0, and maps a null sizeBytes to null (AC 27/28)', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ id: 7, bookId: 'bk_zero', status: 'imported', asin: 'B00ZERO' }]))
          .mockReturnValueOnce(mockDbChain([{ bookId: 7, status: 'available', sizeBytes: 0 }]));

        const zero = await service.findLibraryStatusByAsins(['B00ZERO'], { companionEnabled: true });
        expect(zero.get('B00ZERO')!.companionEbook).toEqual({ format: 'epub', sizeBytes: 0 });

        db.select
          .mockReturnValueOnce(mockDbChain([{ id: 8, bookId: 'bk_nosize', status: 'imported', asin: 'B00NULL' }]))
          .mockReturnValueOnce(mockDbChain([{ bookId: 8, status: 'available', sizeBytes: null }]));

        const nullSize = await service.findLibraryStatusByAsins(['B00NULL'], { companionEnabled: true });
        expect(nullSize.get('B00NULL')!.companionEbook).toBeNull();
      });

      it('yields null for a stale available observation on a non-imported book (AC 22)', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ id: 9, bookId: 'bk_gone', status: 'missing', asin: 'B00GONE' }]))
          .mockReturnValueOnce(mockDbChain([{ bookId: 9, status: 'available', sizeBytes: 5 }]));

        const map = await service.findLibraryStatusByAsins(['B00GONE'], { companionEnabled: true });

        expect(map.get('B00GONE')!.companionEbook).toBeNull();
      });
    });
  });

  describe('create() junction table CRUD', () => {
    it('inserts bookAuthors junction rows with correct positions for multiple authors', async () => {
      const author2 = { id: 2, name: 'Second Author', slug: 'second-author', asin: null, createdAt: new Date(), updatedAt: new Date() };

      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))   // findOrCreate author[0] — found
        .mockReturnValueOnce(mockDbChain([]))             // findOrCreate author[1] — not found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))   // getById book
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }, { author: author2, position: 1 }]))
        .mockReturnValueOnce(mockDbChain([]));

      // Order is book, then per-author find/create + junction; mock drift feeds getById the wrong row.
      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))     // insert book
        .mockReturnValueOnce(mockDbChain([]))              // insert bookAuthors (author 0)
        .mockReturnValueOnce(mockDbChain([author2]))       // insert author[1]
        .mockReturnValueOnce(mockDbChain([]));             // insert bookAuthors (author 1)

      await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }, { name: 'Second Author' }],
      });

      const insertCalls = db.insert.mock.calls;
      expect(insertCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('finds existing author by slug on create, does not insert duplicate', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      });

      const insertCalls = db.insert.mock.calls;
      expect(insertCalls.length).toBe(2);
    });

    it('find-or-creates narrator rows and inserts bookNarrators junction rows with position', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([]))              // narrator not found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))    // book insert
        .mockReturnValueOnce(mockDbChain([]))              // bookAuthors
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator insert
        .mockReturnValueOnce(mockDbChain([]));             // bookNarrators

      const result = await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer'],
      });

      expect(result.narrators).toHaveLength(1);
      expect(result.narrators[0]!.name).toBe('Michael Kramer');
    });

    it('retries narrator find-or-create on unique constraint collision', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([]))              // narrator first lookup: not found
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator retry after constraint: found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));

      const raceChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))    // book insert
        .mockReturnValueOnce(mockDbChain([]))              // bookAuthors
        .mockReturnValueOnce(raceChain)                    // narrator insert — race fails
        .mockReturnValueOnce(mockDbChain([]));             // bookNarrators

      const result = await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer'],
      });

      expect(result.narrators[0]!.name).toBe('Michael Kramer');
    });

    it('deduplicates authors with identical slugs within a single create payload', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))  // author found (first)
        // Duplicate lookup is skipped; this next select belongs to getById.
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // book only
        .mockReturnValueOnce(mockDbChain([]));           // one bookAuthors row

      await service.create({
        title: 'Test',
        authors: [{ name: 'Brandon Sanderson' }, { name: 'Brandon Sanderson' }],
      });

      expect(db.select).toHaveBeenCalledTimes(4);
    });

    it('deduplicates duplicate narrator names within a single create payload', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator found (first lookup)
        // Duplicate lookup is skipped; this next select belongs to getById.
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));
      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // book
        .mockReturnValueOnce(mockDbChain([]))            // bookAuthors
        .mockReturnValueOnce(mockDbChain([]));           // one bookNarrators row

      await service.create({
        title: 'Test',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer', 'Michael Kramer'],
      });

      expect(db.insert).toHaveBeenCalledTimes(3);
    });

    it('deduplicates duplicate narrator names within a single update payload', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      db.delete.mockReturnValue(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator found (first lookup only)
        // Duplicate lookup is skipped; this next select belongs to getById.
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));
      db.insert
        .mockReturnValueOnce(mockDbChain([]));  // one bookNarrators row

      await service.update(1, { narrators: ['Michael Kramer', 'Michael Kramer'] });

      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  // Payload-only tests cannot catch create() dropping productionType before the insert (#1710).
  describe('create() persists productionType into the books insert (#1710)', () => {
    function setupCreateMocks() {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))                                  // author found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))    // getById book
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))         // getById authors
        .mockReturnValueOnce(mockDbChain([]));                                           // getById narrators
      const bookInsertChain = mockDbChain([{ id: 1 }]);
      db.insert
        .mockReturnValueOnce(bookInsertChain)   // book insert (first insert in create())
        .mockReturnValueOnce(mockDbChain([]));  // bookAuthors insert
      return bookInsertChain;
    }

    it('writes the derived production_type from meta.formatType', async () => {
      const bookInsertChain = setupCreateMocks();

      await service.create(buildBookCreatePayload(
        { path: '/x', title: 'The Way of Kings', authorName: 'Brandon Sanderson' },
        { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], formatType: 'Unabridged' },
        'importing',
      ));

      expect(bookInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ productionType: 'unabridged' }),
      );
    });

    it('defaults to unknown when metadata carries no formatType', async () => {
      const bookInsertChain = setupCreateMocks();

      await service.create(buildBookCreatePayload(
        { path: '/x', title: 'The Way of Kings', authorName: 'Brandon Sanderson' },
        { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
        'importing',
      ));

      expect(bookInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ productionType: 'unknown' }),
      );
    });

    // SQLite text enums have no CHECK; parse must reject runtime-invalid values before insert (#1710).
    it('rejects an invalid productionType before the books insert', async () => {
      const bookInsertChain = setupCreateMocks();

      await expect(service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        // Cast simulates an invalid value crossing the TypeScript boundary at runtime.
        productionType: 'not-a-real-type' as ProductionType,
      })).rejects.toThrow();

      expect(bookInsertChain.values).not.toHaveBeenCalled();
    });
  });

  // Unlike create(), update validates a present productionType but must not default an absent key (#1727).
  describe('update() validates productionType at the write boundary (#1727)', () => {
    it('rejects an invalid productionType before the books update', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      setupGetById(db);

      await expect(service.update(1, {
        // Cast simulates an invalid value crossing the TypeScript boundary at runtime.
        productionType: 'not-a-real-type' as ProductionType,
      })).rejects.toThrow();

      // Parse runs before the transaction.
      expect(db.transaction).not.toHaveBeenCalled();
      expect(updateChain.set).not.toHaveBeenCalled();
    });

    it('persists a valid productionType through to .set()', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      setupGetById(db);

      await service.update(1, { productionType: 'full_cast' });

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ productionType: 'full_cast' }),
      );
    });

    it('does not write or default-fill productionType when the key is absent', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      setupGetById(db);

      await service.update(1, { title: 'New Title' });

      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('productionType');
    });
  });

  describe('update() junction table CRUD', () => {
    it('deletes old bookNarrators rows and re-inserts with updated positions on update', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      db.delete.mockReturnValue(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([]))              // narrator lookup: not found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));
      db.insert
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator insert
        .mockReturnValueOnce(mockDbChain([]));             // bookNarrators insert

      await service.update(1, { narrators: ['Michael Kramer'] });

      expect(db.delete).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
    });

    it('clears all narrator junction rows when narrators: [] is passed', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      db.delete.mockReturnValue(mockDbChain([]));
      setupGetById(db, { noNarrators: true });

      await service.update(1, { narrators: [] });

      expect(db.delete).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('leaves author junction rows unchanged when authors is omitted from update', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      await service.update(1, { title: 'New Title' });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('returns null when book not found', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.update(999, { title: 'Nope' });
      expect(result).toBeNull();
    });
  });

  describe('update() scalar + JSON field persistence (#1609)', () => {
    it('passes publishedDate, genres, description, and coverUrl through to .set()', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      setupGetById(db);

      await service.update(1, {
        description: 'A revised description.',
        coverUrl: 'https://example.com/new.jpg',
        publishedDate: '2015-03-14',
        genres: ['Science Fiction', 'Horror'],
      });

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
        description: 'A revised description.',
        coverUrl: 'https://example.com/new.jpg',
        publishedDate: '2015-03-14',
        genres: ['Science Fiction', 'Horror'],
      }));
    });

    it('passes null clears through to .set() for description/coverUrl/publishedDate/genres', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      setupGetById(db);

      await service.update(1, {
        description: null,
        coverUrl: null,
        publishedDate: null,
        genres: null,
      });

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({
        description: null,
        coverUrl: null,
        publishedDate: null,
        genres: null,
      }));
    });

    it('does not include an omitted field in the .set() payload', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      setupGetById(db);

      await service.update(1, { publishedDate: '2015-03-14' });

      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('description');
      expect(setArg).not.toHaveProperty('genres');
      expect(setArg.publishedDate).toBe('2015-03-14');
    });
  });

  describe('create', () => {
    it('creates book without authors', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: mockBook, importListName: null }]),
      );
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await service.create({ title: 'Unknown Book', authors: [] });

      expect(result.title).toBe('The Way of Kings');
    });

    it('writes importListId to books.import_list_id when supplied (#1101)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, importListId: 7 }, importListName: 'My List' }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({ title: 'List Book', authors: [], importListId: 7 });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ importListId: 7 }),
      );
    });

    it('passes enrichmentStatus to the insert payload when supplied (#1622)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({ title: 'Unresolvable Book', authors: [], enrichmentStatus: 'failed' });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ enrichmentStatus: 'failed' }),
      );
    });

    it('leaves enrichmentStatus undefined (DB default applies) when not supplied (#1622)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({ title: 'Default Book', authors: [] });

      const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
      expect(valuesArg.enrichmentStatus).toBeUndefined();
    });

    it('writes a bk_-prefixed publicId to the books insert payload (#1443)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({ title: 'Opaque Id Book', authors: [] });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ publicId: expect.stringMatching(/^bk_/) }),
      );
    });

    it('omits importListId from values when not supplied (existing tests pass undefined)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({ title: 'Manual Book', authors: [] });

      const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
      expect(valuesArg.importListId).toBeUndefined();
    });

    it('creates book with full metadata fields', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([]))              // narrator not found
        .mockReturnValueOnce(mockDbChain([]))              // upsertSeriesLink: series by normalized name (none)
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B003P2WO5E' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));

      const bookInsertChain = mockDbChain([{ id: 1 }]);
      db.insert
        .mockReturnValueOnce(bookInsertChain)              // book insert
        .mockReturnValueOnce(mockDbChain([]))              // bookAuthors
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator insert
        .mockReturnValueOnce(mockDbChain([]));             // bookNarrators

      const result = await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
        narrators: ['Michael Kramer'],
        subtitle: 'Book One of the Stormlight Archive',
        description: 'An epic doorstopper.',
        publisher: 'Macmillan Audio',
        coverUrl: 'https://example.com/wok.jpg',
        asin: 'B003P2WO5E',
        isbn: '9780765326355',
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        duration: 2700,
        publishedDate: '2010-08-31',
        genres: ['Fantasy', 'Epic Fantasy'],
        status: 'imported',
        productionType: 'unabridged',
      });

      expect(result.title).toBe('The Way of Kings');
      // Pins every migrated scalar; series name/position still drive link upsert after provider IDs moved (#1716).
      expect(bookInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'The Way of Kings',
          subtitle: 'Book One of the Stormlight Archive',
          description: 'An epic doorstopper.',
          publisher: 'Macmillan Audio',
          coverUrl: 'https://example.com/wok.jpg',
          asin: 'B003P2WO5E',
          isbn: '9780765326355',
          seriesName: 'The Stormlight Archive',
          seriesPosition: 1,
          duration: 2700,
          publishedDate: '2010-08-31',
          genres: ['Fantasy', 'Epic Fantasy'],
          status: 'imported',
          productionType: 'unabridged',
        }),
      );
    });

    it('persists subtitle and publisher to the books insert (#1614)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({
        title: 'Subtitled Book',
        authors: [],
        subtitle: 'A Grand Subtitle',
        publisher: 'Macmillan Audio',
      });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ subtitle: 'A Grand Subtitle', publisher: 'Macmillan Audio' }),
      );
    });

    it('stores undefined subtitle/publisher (no value → column left null) (#1614)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.create({ title: 'Bare Book', authors: [] });

      const valuesArg = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
      expect(valuesArg.subtitle).toBeUndefined();
      expect(valuesArg.publisher).toBeUndefined();
    });
  });

  // A provider blank ('   ') passed every bare truthiness guard and reached books.series_name (#2224).
  describe('create — an unusable provider series name never reaches the insert', () => {
    /** The shared blank ladder: `undefined` plus every schema-reachable whitespace-only string. */
    const UNUSABLE: Array<[label: string, value: string | undefined]> = [
      ['undefined', undefined],
      ['empty string', ''],
      ['spaces', '   '],
      ['tab + newline', '\t\n'],
      ['non-breaking space', '\u00A0'],
    ];

    function runCreate(seriesName: string | undefined, seriesPosition?: number) {
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);
      return {
        insertChain,
        done: service.create({ title: 'Leviathan Wakes', authors: [], seriesName, seriesPosition }),
      };
    }

    const insertedTables = () => db.insert.mock.calls.map(([table]) => table);

    it.each(UNUSABLE)('%s: neither seriesName nor seriesPosition reaches the insert payload', async (_label, value) => {
      const { insertChain, done } = runCreate(value, 3);
      await done;

      const values = insertChain.values.mock.calls[0]![0] as Record<string, unknown>;
      // Key absence, not falsiness: a present-undefined key would satisfy objectContaining (#2243).
      expect(values).not.toHaveProperty('seriesName');
      expect(values).not.toHaveProperty('seriesPosition');
    });

    it.each(UNUSABLE)('%s: no series row and no member row are seeded', async (_label, value) => {
      const { done } = runCreate(value, 3);
      await done;

      expect(insertedTables()).toEqual([books]);
    });

    it('a usable name still seeds the series link (the negative cases are not vacuous)', async () => {
      const { done } = runCreate('The Expanse', 3);
      await done;

      expect(insertedTables()).toEqual([books, series, seriesMembers]);
    });

    it('a padded-but-usable name is persisted verbatim, alongside its position', async () => {
      const { insertChain, done } = runCreate('  The Expanse  ', 3);
      await done;

      const values = insertChain.values.mock.calls[0]![0] as Record<string, unknown>;
      expect(values).toHaveProperty('seriesName', '  The Expanse  ');
      expect(values).toHaveProperty('seriesPosition', 3);
    });

    it('a position with no name at all stays an orphan that is never written', async () => {
      const { insertChain, done } = runCreate(undefined, 3);
      await done;

      const values = insertChain.values.mock.calls[0]![0] as Record<string, unknown>;
      expect(values).not.toHaveProperty('seriesPosition');
    });
  });

  describe('create with metadataService', () => {
    let serviceWithMeta: BookService;
    let mockMetadata: { getBook: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockMetadata = { getBook: vi.fn().mockResolvedValue(null) };
      serviceWithMeta = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()), inject<MetadataService>(mockMetadata));
    });

    it('enriches ASIN from provider when not provided', async () => {
      mockMetadata.getBook.mockResolvedValueOnce({ title: 'Book', authors: [], asin: 'B_ENRICHED' });
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B_ENRICHED' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await serviceWithMeta.create({ title: 'Test', authors: [], providerId: 'hc-123' });

      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-123');
      // Pins the provider ASIN across the wrapper → primitive → canonicalized insert boundary.
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B_ENRICHED' }),
      );
    });

    it('logs the provider-resolved ASIN on the success line, not the caller\'s absent one (#1898/AC1)', async () => {
      const infoLog = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(infoLog), inject<MetadataService>(mockMetadata));
      mockMetadata.getBook.mockResolvedValueOnce({ title: 'Book', authors: [], asin: 'B_ENRICHED' });
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B_ENRICHED' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await svc.create({ title: 'Test', authors: [], providerId: 'hc-123' });

      // This breadcrumb must record the resolved ASIN the row was added with, including null (#1898).
      expect(infoLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B_ENRICHED' }),
        'Book added to library',
      );
    });

    it('uses provided ASIN and skips enrichment', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await serviceWithMeta.create({ title: 'Test', authors: [], asin: 'B_ALREADY', providerId: 'hc-123' });

      expect(mockMetadata.getBook).not.toHaveBeenCalled();
    });

    it('creates book when getBook returns null (no ASIN found)', async () => {
      const infoLog = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(infoLog), inject<MetadataService>(mockMetadata));
      mockMetadata.getBook.mockResolvedValueOnce(null);
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      const result = await svc.create({ title: 'No ASIN Book', authors: [], providerId: 'hc-999' });

      expect(result.title).toBe('The Way of Kings');
      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-999');
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: null }));
      const infoMock = infoLog.info as Mock;
      expect(infoMock.mock.calls.some((c) => c[1] === 'Enriched book with ASIN from provider')).toBe(false);
      expect(infoLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: null }),
        'Book added to library',
      );
    });

    it('creates book when getBook throws', async () => {
      mockMetadata.getBook.mockRejectedValueOnce(new Error('API timeout'));
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await serviceWithMeta.create({ title: 'Error Book', authors: [], providerId: 'hc-bad' });

      expect(result.title).toBe('The Way of Kings');
    });

    it('logs the exact "ASIN enrichment failed" warn with { error, providerId } and persists null asin (AC4/F8)', async () => {
      const warnLog = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(warnLog), inject<MetadataService>(mockMetadata));
      const boom = new Error('API timeout');
      mockMetadata.getBook.mockRejectedValueOnce(boom);
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await svc.create({ title: 'Error Book', authors: [], providerId: 'hc-bad' });

      expect(warnLog.warn).toHaveBeenCalledWith(
        { error: serializeError(boom), providerId: 'hc-bad' },
        'ASIN enrichment failed',
      );
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: null }));
      expect(warnLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: null }),
        'Book added to library',
      );
    });

    it('inserts null asin when getBook resolves metadata with an ABSENT asin, and emits no enrichment-success log (AC4/F9)', async () => {
      const infoLog = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(infoLog), inject<MetadataService>(mockMetadata));
      mockMetadata.getBook.mockResolvedValueOnce({ title: 'Book', authors: [] });
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await svc.create({ title: 'Absent ASIN Book', authors: [], providerId: 'hc-absent' });

      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-absent');
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: null }));
      const infoMock = infoLog.info as Mock;
      expect(infoMock.mock.calls.some((c) => c[1] === 'Enriched book with ASIN from provider')).toBe(false);
      expect(infoLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: null }),
        'Book added to library',
      );
    });

    // Staged import calls this sole provider-I/O boundary before its per-item transaction (#1893).
    describe('resolveCreateInput (#1893 pre-transaction enrichment)', () => {
      it('carries the provider ASIN and drops providerId (positive)', async () => {
        mockMetadata.getBook.mockResolvedValueOnce({ title: 'Book', authors: [], asin: 'B_ENRICHED' });
        const resolved = await serviceWithMeta.resolveCreateInput({ title: 'Test', authors: [], providerId: 'hc-123' });
        expect(resolved.asin).toBe('B_ENRICHED');
        expect('providerId' in resolved).toBe(false);
        expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-123');
      });

      it('skips provider I/O when an ASIN is already present', async () => {
        const resolved = await serviceWithMeta.resolveCreateInput({ title: 'Test', authors: [], asin: 'B_ALREADY', providerId: 'hc-123' });
        expect(resolved.asin).toBe('B_ALREADY');
        expect(mockMetadata.getBook).not.toHaveBeenCalled();
      });

      it('leaves asin undefined when the provider yields no ASIN (null-ASIN)', async () => {
        mockMetadata.getBook.mockResolvedValueOnce(null);
        const resolved = await serviceWithMeta.resolveCreateInput({ title: 'Test', authors: [], providerId: 'hc-999' });
        expect(resolved.asin).toBeUndefined();
      });

      it('swallows a provider failure and leaves asin undefined', async () => {
        mockMetadata.getBook.mockRejectedValueOnce(new Error('API timeout'));
        const resolved = await serviceWithMeta.resolveCreateInput({ title: 'Test', authors: [], providerId: 'hc-bad' });
        expect(resolved.asin).toBeUndefined();
      });
    });

    it('inserts null asin when getBook resolves metadata with an EMPTY-string asin (AC4/F9)', async () => {
      const infoLog = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(infoLog), inject<MetadataService>(mockMetadata));
      mockMetadata.getBook.mockResolvedValueOnce({ title: 'Book', authors: [], asin: '' });
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await svc.create({ title: 'Empty ASIN Book', authors: [], providerId: 'hc-empty' });

      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: null }));
      const infoMock = infoLog.info as Mock;
      expect(infoMock.mock.calls.some((c) => c[1] === 'Enriched book with ASIN from provider')).toBe(false);
      expect(infoLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: null }),
        'Book added to library',
      );
    });
  });

  // This tx-scoped primitive has no provider I/O or post-commit side effects (#1892).
  describe('createResolved (tx-scoped primitive #1892)', () => {
    let metaLog: ReturnType<typeof createMockLogger>;
    let mockMetadata: { getBook: ReturnType<typeof vi.fn> };
    let primitiveSvc: BookService;

    beforeEach(() => {
      metaLog = createMockLogger();
      mockMetadata = { getBook: vi.fn().mockResolvedValue(null) };
      primitiveSvc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(metaLog), inject<MetadataService>(mockMetadata));
    });

    it('performs zero provider I/O, returns the numeric bookId, and canonicalizes asin (AC2/AC6/AC8/F12)', async () => {
      const insertChain = mockDbChain([{ id: 42 }]);
      db.insert.mockReturnValue(insertChain);

      const id = await primitiveSvc.createResolved({ title: 'Direct', authors: [], asin: 'b003p2wo5e' });

      expect(mockMetadata.getBook).not.toHaveBeenCalled();
      expect(id).toBe(42);
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B003P2WO5E' }));
    });

    it('opens its OWN transaction when no tx is supplied — self-managed atomic write (AC5/F4)', async () => {
      db.insert.mockReturnValue(mockDbChain([{ id: 7 }]));

      await primitiveSvc.createResolved({ title: 'Self Managed', authors: [] });

      // The omitted-tx branch must wrap the multi-table write atomically.
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid productionType at the write boundary and never issues the insert values (AC8)', async () => {
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await expect(
        primitiveSvc.createResolved({ title: 'Bad', authors: [], productionType: 'nonsense' as ProductionType }),
      ).rejects.toThrow();

      expect(insertChain.values).not.toHaveBeenCalled();
    });

    it('runs every write on a supplied tx and never opens db.transaction (AC5)', async () => {
      // This tx mock must be both awaitable and expose .returning().
      const txInsert = mockDbChain([{ id: 55 }]);
      const tx = {
        insert: vi.fn().mockReturnValue(txInsert),
        delete: vi.fn().mockReturnValue(mockDbChain([])),
        select: vi.fn().mockReturnValue(mockDbChain([])),
      };

      const id = await primitiveSvc.createResolved(
        { title: 'On Tx', authors: [{ name: 'Author A' }] },
        inject<DbOrTx>(tx),
      );

      expect(id).toBe(55);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(tx.insert).toHaveBeenCalled();
      expect(tx.delete).toHaveBeenCalled();
    });

    it('emits no "Book added to library" log and writes no genre telemetry on the self-managed path (AC9/F13)', async () => {
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await primitiveSvc.createResolved({ title: 'Quiet', authors: [], genres: ['zzz-not-a-known-genre'] });

      const infoMock = metaLog.info as Mock;
      expect(infoMock.mock.calls.some((c) => c[1] === 'Book added to library')).toBe(false);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('trackUnmatchedGenres', () => {
    it('inserts unmatched genres into telemetry table', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, genres: ['Fantasy', 'Weird Western'] }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await service.create({
        title: 'Test Book',
        authors: [{ name: 'Author' }],
        genres: ['Fantasy', 'Weird Western'],
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(db.insert).toHaveBeenCalled();
    });

    it('uses upsert with count increment for repeat genres', async () => {
      const insertChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, genres: ['Weird Western'] }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      db.insert.mockReturnValue(insertChain);

      await service.create({
        title: 'Test Book',
        authors: [{ name: 'Author' }],
        genres: ['Weird Western'],
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('delegates to update with status', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      const result = await service.updateStatus(1, 'downloading');
      expect(result).not.toBeNull();
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('deleteByStatus', () => {
    it('deletes all matching books and returns count', async () => {
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }, { id: 2 }, { id: 3 }]));

      const result = await service.deleteByStatus('missing');
      expect(result).toBe(3);
    });

    it('returns 0 when no books match status', async () => {
      db.delete.mockReturnValue(mockDbChain([]));

      const result = await service.deleteByStatus('missing');
      expect(result).toBe(0);
    });
  });

  describe('delete', () => {
    it('returns true when book exists', async () => {
      setupGetById(db);
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns false when book not found', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.delete(999);
      expect(result).toBe(false);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('deleteBookFiles', () => {
    // Managed sweep reads Dirents; parent cleanup reads names, and foreign files survive (#1589).
    const dirent = (name: string, isDir = false) =>
      ({ name, isFile: () => !isDir, isDirectory: () => isDir });
    const baseName = (p: string) => p.split(/[\\/]/).pop();

    beforeEach(() => {
      vi.mocked(rm).mockReset();
      vi.mocked(rmdir).mockReset();
      vi.mocked(readdir).mockReset();
      vi.mocked(stat).mockReset();
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
      // Keep these on directory sweep; symlink behavior lives in delete-managed-files.test.ts (#1598).
      vi.mocked(lstat).mockReset();
      vi.mocked(lstat).mockResolvedValue({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as never);
      vi.mocked(rm).mockResolvedValue(undefined);
      vi.mocked(rmdir).mockResolvedValue(undefined);
    });

    it('deletes managed files, preserves foreign files, and returns the summary', async () => {
      vi.mocked(readdir).mockImplementation(async (_p: unknown, opts?: unknown) =>
        ((opts as { withFileTypes?: boolean })?.withFileTypes
          ? [dirent('ch1.mp3'), dirent('cover.jpg'), dirent('book.epub'), dirent('notes.pdf')]
          : ['book.epub', 'notes.pdf']) as never);

      const result = await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(result.deletedManaged.map(baseName).sort()).toEqual(['ch1.mp3', 'cover.jpg']);
      expect(result.preservedForeign.map(baseName).sort()).toEqual(['book.epub', 'notes.pdf']);
      expect(result.failedManaged).toEqual([]);
      expect(rm).toHaveBeenCalledWith(expect.stringContaining('ch1.mp3'), { force: true });
      expect(rm).not.toHaveBeenCalledWith(expect.stringContaining('book.epub'), expect.anything());
    });

    it('cleans up empty parent directories up to library root when only managed files existed', async () => {
      vi.mocked(readdir).mockImplementation(async (_p: unknown, opts?: unknown) =>
        ((opts as { withFileTypes?: boolean })?.withFileTypes ? [dirent('ch1.mp3')] : []) as never);

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(rmdir).toHaveBeenCalledWith(expect.stringContaining('Book'));
      expect(rmdir).toHaveBeenCalledWith(expect.stringContaining('Author'));
    });

    it('stops cleaning parents at a non-empty directory', async () => {
      vi.mocked(readdir).mockImplementation(async (_p: unknown, opts?: unknown) =>
        ((opts as { withFileTypes?: boolean })?.withFileTypes ? [dirent('ch1.mp3')] : ['other-book']) as never);

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(rm).toHaveBeenCalledWith(expect.stringContaining('ch1.mp3'), { force: true });
      expect(rmdir).not.toHaveBeenCalledWith('/audiobooks/Author');
    });

    it('never deletes the library root', async () => {
      vi.mocked(readdir).mockImplementation(async (_p: unknown, opts?: unknown) =>
        ((opts as { withFileTypes?: boolean })?.withFileTypes ? [dirent('a.mp3')] : []) as never);

      await service.deleteBookFiles('/audiobooks/Book', '/audiobooks');

      expect(rmdir).not.toHaveBeenCalledWith('/audiobooks');
    });

    it('records a failed managed deletion in failedManaged without throwing', async () => {
      vi.mocked(readdir).mockImplementation(async (_p: unknown, opts?: unknown) =>
        ((opts as { withFileTypes?: boolean })?.withFileTypes ? [dirent('a.mp3')] : []) as never);
      vi.mocked(rm).mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(result.failedManaged.map(baseName)).toEqual(['a.mp3']);
      expect(result.deletedManaged).toEqual([]);
    });

    it('happy path: in-library path returns a summary and runs parent cleanup (regression)', async () => {
      vi.mocked(readdir).mockImplementation(async (_p: unknown, opts?: unknown) =>
        ((opts as { withFileTypes?: boolean })?.withFileTypes ? [dirent('ch1.mp3'), dirent('keep.txt')] : ['keep.txt']) as never);

      const result = await service.deleteBookFiles('/library/Author/Title', '/library');

      expect(result.deletedManaged.map(baseName)).toEqual(['ch1.mp3']);
      expect(result.preservedForeign.map(baseName)).toEqual(['keep.txt']);
      expect(rm).toHaveBeenCalledWith(expect.stringContaining('ch1.mp3'), { force: true });
      expect(readdir).toHaveBeenCalled();
    });

    it('throws PathOutsideLibraryError when bookPath is outside libraryRoot', async () => {
      await expect(
        service.deleteBookFiles('/tmp/external', '/library'),
      ).rejects.toBeInstanceOf(PathOutsideLibraryError);

      expect(rm).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
    });

    it('throws PathOutsideLibraryError when bookPath equals libraryRoot', async () => {
      await expect(
        service.deleteBookFiles('/library', '/library'),
      ).rejects.toBeInstanceOf(PathOutsideLibraryError);

      expect(rm).not.toHaveBeenCalled();
    });

    it('throws PathOutsideLibraryError when bookPath equals libraryRoot with trailing slash', async () => {
      await expect(
        service.deleteBookFiles('/library/', '/library'),
      ).rejects.toBeInstanceOf(PathOutsideLibraryError);

      expect(rm).not.toHaveBeenCalled();
    });

    it('throws PathOutsideLibraryError on double-dot escape', async () => {
      await expect(
        service.deleteBookFiles('/library/../etc/passwd', '/library'),
      ).rejects.toBeInstanceOf(PathOutsideLibraryError);

      expect(rm).not.toHaveBeenCalled();
    });

    it('throws PathOutsideLibraryError for sibling-prefix attack (/library2)', async () => {
      await expect(
        service.deleteBookFiles('/library2/Author/Title', '/library'),
      ).rejects.toBeInstanceOf(PathOutsideLibraryError);

      expect(rm).not.toHaveBeenCalled();
    });

    it('error has stable name and code, and warn is logged before throwing', async () => {
      const log = createMockLogger();
      const localService = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      let caught: unknown;
      try {
        await localService.deleteBookFiles('/tmp/external', '/library');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PathOutsideLibraryError);
      expect((caught as PathOutsideLibraryError).name).toBe('PathOutsideLibraryError');
      expect((caught as PathOutsideLibraryError).code).toBe('PATH_OUTSIDE_LIBRARY');
      expect((caught as PathOutsideLibraryError).bookPath).toBe('/tmp/external');
      expect((caught as PathOutsideLibraryError).libraryRoot).toBe('/library');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookPath: '/tmp/external', libraryRoot: '/library' }),
        expect.stringContaining('outside library root'),
      );
    });
  });

  describe('create edge cases', () => {
    it('throws when book insert fails', async () => {
      db.insert
        .mockImplementationOnce(() => { throw new Error('UNIQUE constraint failed: books.asin'); });

      await expect(
        service.create({
          title: 'The Way of Kings',
          authors: [{ name: 'Brandon Sanderson' }],
          asin: 'DUPLICATE_ASIN',
        }),
      ).rejects.toThrow('UNIQUE constraint failed');
    });

    it('handles concurrent author creation race condition', async () => {
      const raceChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // book insert
        .mockReturnValueOnce(raceChain)                  // author insert race (in syncAuthors)
        .mockReturnValueOnce(mockDbChain([]));            // bookAuthors junction

      db.select
        .mockReturnValueOnce(mockDbChain([]))            // author lookup: not found
        .mockReturnValueOnce(mockDbChain([mockAuthor]))  // retry after constraint: found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      });

      expect(result.title).toBe('The Way of Kings');
    });

    it('throws when author race retry also fails to find author', async () => {
      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book insert succeeds

      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author not found
        .mockReturnValueOnce(mockDbChain([]));  // retry: still not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);

      await expect(
        service.create({
          title: 'Test',
          authors: [{ name: 'Ghost Author' }],
        }),
      ).rejects.toThrow('Failed to find or create author');
    });

    it('rolls back transaction when author sync fails — no compensating delete needed', async () => {
      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 42 }]));  // book insert succeeds

      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup: not found
        .mockReturnValueOnce(mockDbChain([]));  // retry: still not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);  // author insert fails

      await expect(
        service.create({ title: 'Orphan Book', authors: [{ name: 'Ghost Author' }] }),
      ).rejects.toThrow();

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });
});


describe('BookService.syncAuthors / syncNarrators', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  it('syncAuthors(bookId, []) clears all author junctions without error', async () => {
    db.delete.mockReturnValue(mockDbChain([]));

    await service.syncAuthors(inject<DbOrTx>(db), 10, []);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('syncNarrators(bookId, []) clears all narrator junctions without error', async () => {
    db.delete.mockReturnValue(mockDbChain([]));

    await service.syncNarrators(inject<DbOrTx>(db), 10, []);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('syncAuthors deduplicates by slug — two authors with same slug produce one junction row', async () => {
    db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.delete.mockReturnValue(mockDbChain([]));
    db.insert.mockReturnValue(mockDbChain([]));

    await service.syncAuthors(inject<DbOrTx>(db), 10, [{ name: 'Brandon Sanderson' }, { name: 'Brandon Sanderson' }]);

    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('syncNarrators replaces all narrator junctions with new list', async () => {
    db.select.mockReturnValue(mockDbChain([{ id: 5 }]));
    db.delete.mockReturnValue(mockDbChain([]));
    db.insert.mockReturnValue(mockDbChain([]));

    await service.syncNarrators(inject<DbOrTx>(db), 10, ['Kate Reading', 'Michael Kramer']);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});

describe('BookService — transaction atomicity (#214)', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('create() transaction wrapping', () => {
    it('wraps insert + syncAuthors + syncNarrators in db.transaction()', async () => {
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.create({ title: 'Test', authors: [{ name: 'Brandon Sanderson' }] });

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('rolls back book row when syncAuthors throws', async () => {
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([]))   // findOrCreateAuthor: not found
        .mockReturnValueOnce(mockDbChain([]));   // retry: still not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);

      await expect(
        service.create({ title: 'Test', authors: [{ name: 'Ghost' }] }),
      ).rejects.toThrow('Failed to find or create author');

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back book row and author junctions when syncNarrators throws', async () => {
      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))   // book insert
        .mockReturnValueOnce(mockDbChain([]));             // bookAuthors junction

      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // findOrCreateAuthor: found
        .mockReturnValueOnce(mockDbChain([]))              // findOrCreateNarrator: not found
        .mockReturnValueOnce(mockDbChain([]));             // retry: still not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);  // narrator insert fails

      await expect(
        service.create({
          title: 'Test',
          authors: [{ name: 'Brandon Sanderson' }],
          narrators: ['Ghost Narrator'],
        }),
      ).rejects.toThrow('Failed to find or create narrator');

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('does not contain manual compensating delete — transaction rollback handles cleanup', async () => {
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);

      await expect(
        service.create({ title: 'Test', authors: [{ name: 'Ghost' }] }),
      ).rejects.toThrow();

      expect(db.delete).not.toHaveBeenCalledWith(books);
    });

    it('happy path: book + authors + narrators all committed inside transaction', async () => {
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([mockNarrator]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));

      const result = await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer'],
      });

      expect(result.title).toBe('The Way of Kings');
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledTimes(3);
    });
  });

  describe('update() transaction wrapping', () => {
    it('wraps update + syncNarrators + syncAuthors in db.transaction()', async () => {
      db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockNarrator]))
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.update(1, {
        title: 'Updated',
        narrators: ['Michael Kramer'],
        authors: [{ name: 'Brandon Sanderson' }],
      });

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back book metadata when syncNarrators throws', async () => {
      db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book update succeeds
      db.select
        .mockReturnValueOnce(mockDbChain([]))   // findOrCreateNarrator: not found
        .mockReturnValueOnce(mockDbChain([]));   // retry: not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);

      await expect(
        service.update(1, { narrators: ['Ghost'] }),
      ).rejects.toThrow('Failed to find or create narrator');

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back book metadata and narrator junctions when syncAuthors throws', async () => {
      db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // findOrCreateNarrator: found (success)
        .mockReturnValueOnce(mockDbChain([]))              // findOrCreateAuthor: not found
        .mockReturnValueOnce(mockDbChain([]));             // retry: not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert
        .mockReturnValueOnce(mockDbChain([]))              // bookNarrators junction (success)
        .mockReturnValueOnce(failChain);                   // author insert fails

      await expect(
        service.update(1, {
          narrators: ['Michael Kramer'],
          authors: [{ name: 'Ghost' }],
        }),
      ).rejects.toThrow('Failed to find or create author');

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('returns null without transaction when book ID does not match', async () => {
      db.update.mockReturnValueOnce(mockDbChain([]));

      const result = await service.update(999, { title: 'Nope' });

      expect(result).toBeNull();
      // The transaction wraps the update before its early false return.
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('happy path: book metadata + junctions updated inside transaction', async () => {
      db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.update(1, {
        title: 'Updated Title',
        authors: [{ name: 'Brandon Sanderson' }],
      });

      expect(result).not.toBeNull();
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncAuthors/syncNarrators tx parameter', () => {
    it('syncAuthors uses tx for delete and insert operations, not this.db', async () => {
      const tx = createMockDb();
      tx.select.mockReturnValue(mockDbChain([{ id: 1 }]));

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson' }]);

      expect(tx.delete).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('syncNarrators uses tx for delete and insert operations, not this.db', async () => {
      const tx = createMockDb();
      tx.select.mockReturnValue(mockDbChain([{ id: 5 }]));

      await service.syncNarrators(inject<DbOrTx>(tx), 10, ['Michael Kramer']);

      expect(tx.delete).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('findOrCreateAuthor uses tx for select and insert, not this.db', async () => {
      const tx = createMockDb();
      tx.select.mockReturnValueOnce(mockDbChain([]));  // not found → will insert
      tx.insert
        .mockReturnValueOnce(mockDbChain([{ id: 7 }]))  // author created
        .mockReturnValueOnce(mockDbChain([]));            // junction

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'New Author' }]);

      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(2);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('findOrCreateNarrator uses tx for select and insert, not this.db', async () => {
      const tx = createMockDb();
      tx.select.mockReturnValueOnce(mockDbChain([]));  // not found → will insert
      tx.insert
        .mockReturnValueOnce(mockDbChain([{ id: 3 }]))  // narrator created
        .mockReturnValueOnce(mockDbChain([]));            // junction

      await service.syncNarrators(inject<DbOrTx>(tx), 10, ['New Narrator']);

      expect(tx.select).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(2);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('findOrCreateAuthor ASIN backfill (#437)', () => {
    it('backfills null ASIN on existing author when caller provides one', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor]));
      tx.update.mockReturnValueOnce(mockDbChain([]));
      tx.delete.mockReturnValueOnce(mockDbChain([]));
      tx.insert.mockReturnValueOnce(mockDbChain([]));

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }]);

      expect(tx.update).toHaveBeenCalledTimes(1);
      const updateChain = tx.update.mock.results[0]!.value;
      expect(updateChain.set).toHaveBeenCalledWith({ asin: 'B001IGFHW6' });
      expect(updateChain.where).toHaveBeenCalledWith(eq(authors.id, 5));

      const junctionChain = tx.insert.mock.results[0]!.value;
      expect(junctionChain.values).toHaveBeenCalledWith({ bookId: 10, authorId: 5, position: 0 });
    });

    it('does not overwrite existing non-null ASIN (first-write-wins)', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: 'B_OLD' });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor]));
      tx.delete.mockReturnValueOnce(mockDbChain([]));
      tx.insert.mockReturnValueOnce(mockDbChain([]));

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: 'B_NEW' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });

    it('does not update when caller provides no ASIN (undefined)', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor]));
      tx.delete.mockReturnValueOnce(mockDbChain([]));
      tx.insert.mockReturnValueOnce(mockDbChain([]));

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });

    it('does not update when caller provides empty string ASIN', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor]));
      tx.delete.mockReturnValueOnce(mockDbChain([]));
      tx.insert.mockReturnValueOnce(mockDbChain([]));

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: '' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });

    it('backfills ASIN on conflict-retry path (unique constraint race)', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select
        .mockReturnValueOnce(mockDbChain([]))                      // first lookup: not found
        .mockReturnValueOnce(mockDbChain([existingAuthor]));        // retry lookup after conflict
      tx.insert
        .mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') })) // insert fails
        .mockReturnValueOnce(mockDbChain([]));                      // junction insert
      tx.update.mockReturnValueOnce(mockDbChain([]));               // ASIN backfill
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }]);

      expect(tx.update).toHaveBeenCalledTimes(1);
      const updateChain = tx.update.mock.results[0]!.value;
      expect(updateChain.set).toHaveBeenCalledWith({ asin: 'B001IGFHW6' });
      expect(updateChain.where).toHaveBeenCalledWith(eq(authors.id, 5));

      const junctionChain = tx.insert.mock.results[1]!.value;  // [0] is the failed author insert
      expect(junctionChain.values).toHaveBeenCalledWith({ bookId: 10, authorId: 5, position: 0 });
    });

    it('does not overwrite existing ASIN on conflict-retry path (first-write-wins)', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: 'B_OLD' });
      tx.select
        .mockReturnValueOnce(mockDbChain([]))                      // first lookup: not found
        .mockReturnValueOnce(mockDbChain([existingAuthor]));        // retry lookup: has ASIN
      tx.insert
        .mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') })) // insert fails
        .mockReturnValueOnce(mockDbChain([]));                      // junction insert
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: 'B_NEW' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });

    it('does not update on conflict-retry path when caller provides no ASIN', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select
        .mockReturnValueOnce(mockDbChain([]))                      // first lookup: not found
        .mockReturnValueOnce(mockDbChain([existingAuthor]));        // retry lookup: null ASIN
      tx.insert
        .mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') })) // insert fails
        .mockReturnValueOnce(mockDbChain([]));                      // junction insert
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe('logging improvements (#229)', () => {
    it('create log includes { authors, asin }', async () => {
      const log = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B003P2WO5E' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await svc.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        asin: 'B003P2WO5E',
      });

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ authors: ['Brandon Sanderson'], asin: 'B003P2WO5E' }),
        'Book added to library',
      );
    });

    it('create log carries the canonical ASIN that was persisted, not the caller\'s casing (#1898/AC2)', async () => {
      const log = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));

      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B003P2WO5E' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      await svc.create({ title: 'The Way of Kings', authors: [], asin: 'b003p2wo5e' });

      // Pairing both assertions pins log-equals-persisted, not merely uppercase logging.
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B003P2WO5E' }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B003P2WO5E' }),
        'Book added to library',
      );
    });

    it('create log reports null for a whitespace-only caller ASIN, matching the persisted column (#1898/AC2)', async () => {
      const log = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));

      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      await svc.create({ title: 'Blank ASIN', authors: [], asin: '   ' });

      // `'   '` is truthy; raw passthrough would log whitespace against a stored null.
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ asin: null }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ asin: null }),
        'Book added to library',
      );
    });

    it('update log includes { changedFields }', async () => {
      const log = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));

      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      await svc.update(1, { title: 'Updated Title', description: 'New description' });

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, changedFields: expect.arrayContaining(['title', 'description']) }),
        'Book updated',
      );
    });

    it('delete log includes { title }', async () => {
      const log = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));

      setupGetById(db);
      db.delete.mockReturnValue(mockDbChain());

      await svc.delete(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, title: 'The Way of Kings' }),
        'Book removed',
      );
    });
  });

  describe('update() genre telemetry', () => {
    it('calls trackUnmatchedGenres fire-and-forget when genres are provided in update payload', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.update(1, { genres: ['Weird Western'] });

      // Let fire-and-forget telemetry settle.
      await new Promise((r) => setTimeout(r, 50));

      expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it('does NOT track genres the normalizer already handles', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      // `Sci-Fi` normalizes to `Science Fiction`, so it is not unmatched.
      await service.update(1, { genres: ['Sci-Fi'] });

      await new Promise((r) => setTimeout(r, 50));

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does NOT call trackUnmatchedGenres when genres are absent from update payload', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      await service.update(1, { title: 'New Title' });

      await new Promise((r) => setTimeout(r, 50));

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('trackUnmatchedGenres failure during update does not reject the update promise', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      db.insert.mockReturnValue(mockDbChain(undefined, { error: new Error('DB write failed') }));

      const result = await service.update(1, { genres: ['Weird Western'] });
      expect(result).not.toBeNull();

      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('uploadCover', () => {
    const testBuffer = Buffer.from('fake-image-data');

    function setupUploadMocks(bookPath: string | null) {
      const bookWithPath = createMockDbBook({ path: bookPath, coverUrl: null });
      // Initial getById: book, authors, narrators.
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: bookWithPath, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));
      (writeFile as Mock).mockResolvedValue(undefined);
      (rename as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue([]);
      db.update.mockReturnValue(mockDbChain([bookWithPath]));
      // getById for return value: book, authors, narrators.
      const updatedBook = createMockDbBook({ path: bookPath, coverUrl: `/api/books/1/cover` });
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: updatedBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));
    }

    it('writes file to temp path then renames atomically to cover.{ext}', async () => {
      setupUploadMocks('/library/book');

      await service.uploadCover(1, testBuffer, 'image/jpeg');

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.cover-upload-'),
        testBuffer,
      );
      expect(rename).toHaveBeenCalledWith(
        expect.stringContaining('.cover-upload-'),
        expect.stringContaining('cover.jpg'),
      );
    });

    it('removes stale cover files with different extensions after write', async () => {
      setupUploadMocks('/library/book');
      (readdir as Mock).mockResolvedValue(['cover.jpg', 'cover.png']);
      (unlink as Mock).mockResolvedValue(undefined);

      await service.uploadCover(1, testBuffer, 'image/png');

      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('cover.jpg'));
      expect(unlink).not.toHaveBeenCalledWith(expect.stringContaining('cover.png'));
    });

    it('updates DB with coverUrl and updatedAt immediately after rename', async () => {
      setupUploadMocks('/library/book');

      await service.uploadCover(1, testBuffer, 'image/jpeg');

      expect(db.update).toHaveBeenCalled();
      const setCall = db.update.mock.results[0]!.value.set;
      expect(setCall).toHaveBeenCalledWith(expect.objectContaining({
        coverUrl: '/api/books/1/cover',
      }));
    });

    // A committed cover must still trigger connector refresh if the post-write reload fails (#1721).
    it("falls back to the pre-write book and keeps coverOutcome 'written' when the post-write reload fails", async () => {
      vi.mocked(writeFile).mockReset();
      vi.mocked(rename).mockReset();
      vi.mocked(readdir).mockReset();
      vi.mocked(unlink).mockReset();
      const preWriteBook = createMockDbBook({ id: 1, path: '/library/book', coverUrl: null });
      const getByIdSpy = vi.spyOn(service, 'getById')
        .mockResolvedValueOnce(preWriteBook as unknown as Awaited<ReturnType<BookService['getById']>>) // initial existence/path check
        .mockRejectedValueOnce(new Error('libSQL read failed')); // post-write reload throws
      (writeFile as Mock).mockResolvedValue(undefined);
      (rename as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue([]);
      db.update.mockReturnValue(mockDbChain([preWriteBook]));

      const result = await service.uploadCover(1, testBuffer, 'image/jpeg');

      expect(result.coverOutcome).toBe('written');
      expect(result.book).toBe(preWriteBook);
      getByIdSpy.mockRestore();
    });

    it('throws CoverUploadError with NO_PATH when book has no path', async () => {
      (writeFile as Mock).mockClear();
      setupUploadMocks(null);

      const err = await service.uploadCover(1, testBuffer, 'image/jpeg').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CoverUploadError);
      expect((err as CoverUploadError).code).toBe('NO_PATH');

      expect(writeFile).not.toHaveBeenCalled();
    });

    it('throws CoverUploadError with NOT_FOUND when book does not exist', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.uploadCover(999, testBuffer, 'image/jpeg').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CoverUploadError);
      expect((err as CoverUploadError).code).toBe('NOT_FOUND');
    });

    it('throws CoverUploadError with INVALID_MIME for unsupported MIME type', async () => {
      const err = await service.uploadCover(1, testBuffer, 'image/gif').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CoverUploadError);
      expect((err as CoverUploadError).code).toBe('INVALID_MIME');
    });

    it('cleans up temp file when rename fails (no partial state)', async () => {
      setupUploadMocks('/library/book');
      (rename as Mock).mockRejectedValue(new Error('EACCES'));
      (unlink as Mock).mockResolvedValue(undefined);

      await expect(service.uploadCover(1, testBuffer, 'image/jpeg')).rejects.toThrow('EACCES');

      expect(writeFile).toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('.cover-upload-'));
    });

    it('still succeeds when readdir rejects (ENOENT) — .catch(() => []) fallback exercised', async () => {
      vi.mocked(readdir).mockReset();
      vi.mocked(rename).mockReset();
      vi.mocked(writeFile).mockReset();
      vi.mocked(unlink).mockReset();
      setupUploadMocks('/library/book');
      vi.mocked(readdir).mockRejectedValue(new Error('ENOENT: no such file or directory'));

      await service.uploadCover(1, testBuffer, 'image/jpeg');

      expect(db.update).toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('still succeeds when stale sibling unlink rejects (EACCES) — best-effort cleanup swallowed', async () => {
      vi.mocked(readdir).mockReset();
      vi.mocked(rename).mockReset();
      vi.mocked(writeFile).mockReset();
      vi.mocked(unlink).mockReset();
      setupUploadMocks('/library/book');
      vi.mocked(readdir).mockResolvedValue(['cover.jpg', 'cover.png'] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(unlink).mockRejectedValue(new Error('EACCES: permission denied'));

      await service.uploadCover(1, testBuffer, 'image/png');

      expect(db.update).toHaveBeenCalled();
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('cover.jpg'));
    });
  });
});
