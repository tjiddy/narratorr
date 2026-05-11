import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';

// Mock inArray to capture the chunk argument so chunking tests can assert
// each chunk is bounded ≤ 900 IDs (SQLite 999-bind-limit guard). Other
// drizzle-orm helpers (eq, and, sql, notExists, ...) pass through unchanged.
vi.mock('drizzle-orm', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    inArray: vi.fn(actual.inArray),
  };
});

import { BookService, CoverUploadError } from './book.service.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { eq, inArray } from 'drizzle-orm';
import { authors, books, bookAuthors, bookNarrators } from '../../db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '../../db/index.js';
import type { MetadataService } from './metadata.service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    rm: vi.fn(),
    rmdir: vi.fn(),
    readdir: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
  };
});

import { rm, rmdir, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import type { Mock } from 'vitest';

const mockAuthor = createMockDbAuthor();
const mockBook = createMockDbBook();
const mockNarrator = { id: 1, name: 'Michael Kramer', slug: 'michael-kramer', createdAt: new Date('2024-01-01T00:00:00Z') };

/** Setup db.select to return the three-query pattern for getById:
 *  1st call: book + importListName
 *  2nd call: bookAuthors + authors
 *  3rd call: bookNarrators + narrators
 */
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
      // Authors should be in position order: 0 first
      expect(result!.authors[0]!.name).toBe('Brandon Sanderson');
      expect(result!.authors[1]!.name).toBe('Second Author');
    });
  });

  describe('findDuplicate', () => {
    it('finds duplicate by ASIN', async () => {
      // getById after ASIN match: 3 selects
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // ASIN lookup
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B003P2WO5E' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.findDuplicate('The Way of Kings', [{ name: 'Brandon Sanderson' }], 'B003P2WO5E');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
    });

    it('finds duplicate by title + primary-author slug (position=0) when no ASIN', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // title+author match
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))  // getById book
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.findDuplicate('The Way of Kings', [{ name: 'Brandon Sanderson' }]);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
    });

    it('[A, B] vs [A, C] same title is duplicate (co-author difference ignored)', async () => {
      // Position-0 author slug matches → duplicate
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // title+position0 author match
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.findDuplicate('The Way of Kings', [{ name: 'Brandon Sanderson' }, { name: 'Co Author' }]);
      expect(result).not.toBeNull();
    });

    it('[A, B] vs [B, A] same title is not duplicate (primary author differs)', async () => {
      // When position-0 author is different (B vs A), no match
      db.select.mockReturnValueOnce(mockDbChain([]));  // title+position0 author: not found

      const result = await service.findDuplicate('The Way of Kings', [{ name: 'Second Author' }]);
      expect(result).toBeNull();
    });

    it('returns null when no duplicate', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // ASIN lookup
        .mockReturnValueOnce(mockDbChain([]));  // title+author lookup

      const result = await service.findDuplicate('New Book', [{ name: 'New Author' }], 'B000NEW');
      expect(result).toBeNull();
    });

    it('with no authors array, only ASIN matching applies', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // ASIN match
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.findDuplicate('Title', undefined, 'B003P2WO5E');
      expect(result).not.toBeNull();
    });

    it('finds duplicate by title only when no authors and no ASIN (#246)', async () => {
      // title-only lookup → match, then getById
      // JS eval order: outer db.select() first, then inner db.select() for notExists subquery
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // outer title-only query match
        .mockReturnValueOnce(mockDbChain([]))            // notExists subquery builder (consumed but not awaited)
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.findDuplicate('The Way of Kings');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
    });

    it('finds duplicate by title only with empty authors array (#246)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // outer query
        .mockReturnValueOnce(mockDbChain([]))            // notExists subquery
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.findDuplicate('The Way of Kings', []);
      expect(result).not.toBeNull();
    });

    it('returns null for title-only when no match found (#246)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))   // outer title-only query: not found
        .mockReturnValueOnce(mockDbChain([]));  // notExists subquery builder

      const result = await service.findDuplicate('Nonexistent Book');
      expect(result).toBeNull();
    });

    it('skips ASIN check when not provided, falls through to title+author', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));  // title+author: not found

      const result = await service.findDuplicate('The Way of Kings', [{ name: 'Brandon Sanderson' }], undefined);
      expect(result).toBeNull();
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    // #253 — title-only branch must exclude authored books
    it('title-only: does NOT match an authored book with the same title → returns null (#253)', async () => {
      // JS eval: outer db.select() first, then inner db.select() for notExists
      const outerChain = mockDbChain([]);
      const subqueryChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(outerChain)    // outer title-only query: no authorless match
        .mockReturnValueOnce(subqueryChain); // notExists subquery builder

      const result = await service.findDuplicate('The Way of Kings');
      expect(result).toBeNull();
      expect(db.select).toHaveBeenCalledTimes(2);  // outer query + subquery, no getById

      // Verify the full title-only predicate contract: and(eq(books.title, title), notExists(bookAuthors correlated)) (#253)
      // Helper: recursively find a column reference by table name and column name in Drizzle SQL tree
      const drizzleNameSym = Symbol.for('drizzle:Name');
      function findColumn(node: unknown, tableName: string, colName: string): boolean {
        if (!node || typeof node !== 'object') return false;
        const obj = node as Record<string | symbol, unknown>;
        // Column reference: has .name and .table[Symbol.for('drizzle:Name')]
        if (obj.name === colName && typeof obj.table === 'object' && obj.table !== null
          && (obj.table as Record<symbol, unknown>)[drizzleNameSym] === tableName) return true;
        if (Array.isArray(obj.queryChunks)) return obj.queryChunks.some((c: unknown) => findColumn(c, tableName, colName));
        return false;
      }
      function findText(node: unknown, needle: string): boolean {
        if (!node || typeof node !== 'object') return false;
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj.value) && obj.value.some((v: unknown) => typeof v === 'string' && v.includes(needle))) return true;
        if (Array.isArray(obj.queryChunks)) return obj.queryChunks.some((c: unknown) => findText(c, needle));
        return false;
      }

      const outerWhere = outerChain.where as Mock;
      expect(outerWhere).toHaveBeenCalledTimes(1);
      const predicate = outerWhere.mock.calls[0]![0];

      // 1. Outer predicate contains eq(books.title, title) — title column reference present
      expect(findColumn(predicate, 'books', 'title')).toBe(true);

      // 2. Outer predicate contains "not exists" operator
      expect(findText(predicate, 'not exists')).toBe(true);

      // 3. Outer query selects from books table
      expect(outerChain.from).toHaveBeenCalledWith(books);

      // 4. Subquery selects from bookAuthors table
      expect(subqueryChain.from).toHaveBeenCalledWith(bookAuthors);

      // 5. Subquery where() is eq(bookAuthors.bookId, books.id) — single equality with both operands
      const subqueryWhere = subqueryChain.where as Mock;
      expect(subqueryWhere).toHaveBeenCalledTimes(1);
      const subPredicate = subqueryWhere.mock.calls[0]![0];
      // eq() produces a flat SQL: [StringChunk(''), Column(book_id), StringChunk(' = '), Column(id), StringChunk('')]
      const chunks = subPredicate.queryChunks;
      expect(chunks).toHaveLength(5);
      // chunk[1]: left operand — bookAuthors.bookId
      expect(chunks[1].name).toBe('book_id');
      expect(chunks[1].table[drizzleNameSym]).toBe('book_authors');
      // chunk[2]: equality operator
      expect(chunks[2].value).toContain(' = ');
      // chunk[3]: right operand — books.id
      expect(chunks[3].name).toBe('id');
      expect(chunks[3].table[drizzleNameSym]).toBe('books');
    });

    it('title-only: returns authorless book when both authored and authorless exist (#253)', async () => {
      // Outer query returns authorless book (authored excluded by notExists predicate)
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 42 }]))  // outer query: authorless book found
        .mockReturnValueOnce(mockDbChain([]))             // notExists subquery builder
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, id: 42 }, importListName: null }]))  // getById book
        .mockReturnValueOnce(mockDbChain([]))             // getById authors (authorless)
        .mockReturnValueOnce(mockDbChain([]));            // getById narrators

      const result = await service.findDuplicate('The Way of Kings');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(42);
      expect(result!.authors).toEqual([]);
    });

    it('title-only: empty array triggers same authorless-only behavior as undefined (#253)', async () => {
      // [] hits same title-only branch as undefined
      db.select
        .mockReturnValueOnce(mockDbChain([]))   // outer query: no authorless match
        .mockReturnValueOnce(mockDbChain([]));  // notExists subquery builder

      const result = await service.findDuplicate('The Way of Kings', []);
      expect(result).toBeNull();
      expect(db.select).toHaveBeenCalledTimes(2);  // outer query + subquery
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

      db.insert
        .mockReturnValueOnce(mockDbChain([author2]))       // insert author[1]
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))     // insert book
        .mockReturnValueOnce(mockDbChain([]))              // insert bookAuthors
        .mockReturnValueOnce(mockDbChain([]));             // insert bookAuthors (2nd author)

      await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }, { name: 'Second Author' }],
      });

      // bookAuthors inserts: one for each author
      const insertCalls = db.insert.mock.calls;
      // bookAuthors inserts should have been called with position 0 and 1
      expect(insertCalls.length).toBeGreaterThanOrEqual(3); // book insert + at least 2 junction inserts
    });

    it('finds existing author by slug on create, does not insert duplicate', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))    // book insert
        .mockReturnValueOnce(mockDbChain([]));             // bookAuthors insert

      await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      });

      // No author insert — found existing
      const insertCalls = db.insert.mock.calls;
      // Should be: book insert + bookAuthors insert (no author insert)
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
      // Both authors normalize to same slug → only one findOrCreate and one bookAuthors row
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))  // author found (first)
        // second lookup skipped due to dedup
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // book only
        .mockReturnValueOnce(mockDbChain([]));           // one bookAuthors row

      await service.create({
        title: 'Test',
        authors: [{ name: 'Brandon Sanderson' }, { name: 'Brandon Sanderson' }],  // duplicate
      });

      // author lookup (1) + getById (3 selects: book, authors, narrators) = 4
      expect(db.select).toHaveBeenCalledTimes(4);
    });

    it('deduplicates duplicate narrator names within a single create payload', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator found (first lookup)
        // second narrator skipped due to dedup
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
        narrators: ['Michael Kramer', 'Michael Kramer'],  // duplicate
      });

      // Only one bookNarrators insert (not two) despite two narrator entries in payload
      expect(db.insert).toHaveBeenCalledTimes(3);
    });

    it('deduplicates duplicate narrator names within a single update payload', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      db.delete.mockReturnValue(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator found (first lookup only)
        // second narrator skipped due to dedup
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));
      db.insert
        .mockReturnValueOnce(mockDbChain([]));  // one bookNarrators row

      await service.update(1, { narrators: ['Michael Kramer', 'Michael Kramer'] });

      // Only one bookNarrators insert (not two) despite two narrator entries in payload
      expect(db.insert).toHaveBeenCalledTimes(1);
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

      expect(db.delete).toHaveBeenCalled();  // old bookNarrators deleted
      expect(db.insert).toHaveBeenCalled();  // new bookNarrators inserted
    });

    it('clears all narrator junction rows when narrators: [] is passed', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      db.delete.mockReturnValue(mockDbChain([]));
      setupGetById(db, { noNarrators: true });

      await service.update(1, { narrators: [] });

      expect(db.delete).toHaveBeenCalled();  // bookNarrators deleted
      expect(db.insert).not.toHaveBeenCalled();  // no re-insert
    });

    it('leaves author junction rows unchanged when authors is omitted from update', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      await service.update(1, { title: 'New Title' });

      // No delete or insert for bookAuthors
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('returns null when book not found', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.update(999, { title: 'Nope' });
      expect(result).toBeNull();
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

      expect(result.title).toBe('The Way of Kings'); // from mock
    });

    it('creates book with full metadata fields', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // author found
        .mockReturnValueOnce(mockDbChain([]))              // narrator not found
        .mockReturnValueOnce(mockDbChain([]))              // upsertSeriesLink: series by normalized name (none)
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B003P2WO5E' }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ narrator: mockNarrator, position: 0 }]));

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))    // book insert
        .mockReturnValueOnce(mockDbChain([]))              // bookAuthors
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // narrator insert
        .mockReturnValueOnce(mockDbChain([]));             // bookNarrators

      const result = await service.create({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
        narrators: ['Michael Kramer'],
        asin: 'B003P2WO5E',
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        duration: 2700,
        publishedDate: '2010-08-31',
        genres: ['Fantasy', 'Epic Fantasy'],
      });

      expect(result.title).toBe('The Way of Kings');
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
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await serviceWithMeta.create({ title: 'Test', authors: [], providerId: 'hc-123' });

      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-123');
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
      mockMetadata.getBook.mockResolvedValueOnce(null);
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await serviceWithMeta.create({ title: 'No ASIN Book', authors: [], providerId: 'hc-999' });

      expect(result.title).toBe('The Way of Kings'); // from mock
      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-999');
    });

    it('creates book when getBook throws', async () => {
      mockMetadata.getBook.mockRejectedValueOnce(new Error('API timeout'));
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await serviceWithMeta.create({ title: 'Error Book', authors: [], providerId: 'hc-bad' });

      expect(result.title).toBe('The Way of Kings'); // still creates
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

      // author insert skipped (found), book insert, bookAuthors, unmatched genre upsert
      // The exact count depends on whether author was found or not
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
    beforeEach(() => {
      vi.mocked(rm).mockReset();
      vi.mocked(readdir).mockReset();
    });

    it('deletes book directory recursively', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue(['other-file.txt']);

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(rm).toHaveBeenCalledWith('/audiobooks/Author/Book', { recursive: true, force: true });
    });

    it('cleans up empty parent directories up to library root', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (rmdir as Mock).mockResolvedValue(undefined);
      (readdir as Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(rmdir).toHaveBeenCalledTimes(1);
      expect(rmdir).toHaveBeenCalledWith(expect.stringContaining('Author'));
    });

    it('stops cleaning parents at non-empty directory', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValueOnce(['other-book']);

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      expect(rm).toHaveBeenCalledTimes(1);
    });

    it('never deletes the library root', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue([]);

      await service.deleteBookFiles('/audiobooks/Book', '/audiobooks');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(rm).toHaveBeenCalledWith('/audiobooks/Book', { recursive: true, force: true });
    });

    it('throws when rm fails', async () => {
      (rm as Mock).mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(
        service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks'),
      ).rejects.toThrow('EACCES: permission denied');
    });

    it('happy path: in-library path triggers rm and parent cleanup (regression)', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue(['other-file.txt']);

      await service.deleteBookFiles('/library/Author/Title', '/library');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(rm).toHaveBeenCalledWith('/library/Author/Title', { recursive: true, force: true });
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
      // Book insert is first; author find-or-create happens in syncAuthors after
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
      // New order: book insert first, then syncAuthors (delete + find/create + insert junction)
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
      // Book insert succeeds; author insert in syncAuthors fails with race
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
      // Book insert succeeds, then syncAuthors fails immediately (no author found, no retry)
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

      // Transaction handles rollback — no manual compensating delete of books table
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });
  });
});

describe('BookService batch-load (N+1 fix)', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
    // Reset captured calls on the inArray spy so each test asserts only its own chunks.
    vi.mocked(inArray).mockClear();
  });

  /** Extract the integer bookIds passed to every `inArray(<column>, ids)` call
   *  whose column resolves to bookAuthors.bookId or bookNarrators.bookId. The
   *  first call argument is the Drizzle column object (referential identity);
   *  the second is the array of IDs we want to verify is bounded ≤ 900. */
  function inArrayCallsFor(column: unknown): number[][] {
    return vi.mocked(inArray).mock.calls
      .filter((call) => call[0] === column)
      .map((call) => call[1] as number[]);
  }

  it('getMonitoredBooks() with 3 monitored books issues exactly 3 DB queries total', async () => {
    const book1 = createMockDbBook({ id: 1 });
    const book2 = createMockDbBook({ id: 2, title: 'Words of Radiance' });
    const book3 = createMockDbBook({ id: 3, title: 'Oathbringer' });
    // 1st select: books query with monitorForUpgrades + status filter
    db.select.mockReturnValueOnce(mockDbChain([book1, book2, book3]));
    // 2nd select: batch authors for all 3 books
    db.select.mockReturnValueOnce(mockDbChain([
      { bookId: 1, author: mockAuthor, position: 0 },
      { bookId: 2, author: mockAuthor, position: 0 },
      { bookId: 3, author: mockAuthor, position: 0 },
    ]));
    // 3rd select: batch narrators for all 3 books
    db.select.mockReturnValueOnce(mockDbChain([]));

    await service.getMonitoredBooks();

    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it('getMonitoredBooks() returns BookWithAuthor[] with authors/narrators arrays populated', async () => {
    const book1 = createMockDbBook({ id: 1 });
    db.select
      .mockReturnValueOnce(mockDbChain([book1]))
      .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
      .mockReturnValueOnce(mockDbChain([{ bookId: 1, narrator: mockNarrator, position: 0 }]));

    const results = await service.getMonitoredBooks();

    expect(results).toHaveLength(1);
    expect(results[0]!.authors).toEqual([mockAuthor]);
    expect(results[0]!.narrators).toEqual([mockNarrator]);
  });

  it('getMonitoredBooks() with 0 monitored books returns [] and skips author/narrator queries', async () => {
    db.select.mockReturnValueOnce(mockDbChain([]));

    const results = await service.getMonitoredBooks();

    expect(results).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('getMonitoredBooks() with exactly 900 books issues a single chunked author/narrator query each', async () => {
    const bookRows = Array.from({ length: 900 }, (_, i) => createMockDbBook({ id: i + 1 }));
    const authorRows = bookRows.map((b) => ({ bookId: b.id, author: mockAuthor, position: 0 }));
    const narratorRows = bookRows.map((b) => ({ bookId: b.id, narrator: mockNarrator, position: 0 }));
    const expectedIds = bookRows.map((b) => b.id);

    db.select
      .mockReturnValueOnce(mockDbChain(bookRows))
      .mockReturnValueOnce(mockDbChain(authorRows))
      .mockReturnValueOnce(mockDbChain(narratorRows));

    const results = await service.getMonitoredBooks();

    // 1 books query + 1 author chunk + 1 narrator chunk = 3 selects (no second chunk)
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(900);
    expect(results[0]!.authors).toEqual([mockAuthor]);
    expect(results[0]!.narrators).toEqual([mockNarrator]);

    // The single chunk for each side targets the right column with all 900 IDs (≤ 900).
    const authorChunks = inArrayCallsFor(bookAuthors.bookId);
    const narratorChunks = inArrayCallsFor(bookNarrators.bookId);
    expect(authorChunks).toHaveLength(1);
    expect(narratorChunks).toHaveLength(1);
    expect(authorChunks[0]).toEqual(expectedIds);
    expect(narratorChunks[0]).toEqual(expectedIds);
    expect(authorChunks[0]!.length).toBeLessThanOrEqual(900);
    expect(narratorChunks[0]!.length).toBeLessThanOrEqual(900);
  });

  it('getMonitoredBooks() with 901 books splits authors/narrators into bounded chunks of 900 + 1', async () => {
    const bookRows = Array.from({ length: 901 }, (_, i) => createMockDbBook({ id: i + 1 }));
    const expectedFirstChunk = bookRows.slice(0, 900).map((b) => b.id);
    const expectedSecondChunk = bookRows.slice(900).map((b) => b.id);
    const firstAuthorRows = bookRows.slice(0, 900).map((b) => ({ bookId: b.id, author: mockAuthor, position: 0 }));
    const secondAuthorRows = bookRows.slice(900).map((b) => ({ bookId: b.id, author: mockAuthor, position: 0 }));
    const firstNarratorRows = bookRows.slice(0, 900).map((b) => ({ bookId: b.id, narrator: mockNarrator, position: 0 }));
    const secondNarratorRows = bookRows.slice(900).map((b) => ({ bookId: b.id, narrator: mockNarrator, position: 0 }));

    db.select
      .mockReturnValueOnce(mockDbChain(bookRows))
      .mockReturnValueOnce(mockDbChain(firstAuthorRows))
      .mockReturnValueOnce(mockDbChain(secondAuthorRows))
      .mockReturnValueOnce(mockDbChain(firstNarratorRows))
      .mockReturnValueOnce(mockDbChain(secondNarratorRows));

    const results = await service.getMonitoredBooks();

    // 1 books query + 2 author chunks + 2 narrator chunks = 5 selects
    expect(db.select).toHaveBeenCalledTimes(5);
    expect(results).toHaveLength(901);
    // No duplicates: book #1 has exactly one author/narrator from the first chunk
    expect(results[0]!.authors).toEqual([mockAuthor]);
    expect(results[0]!.narrators).toEqual([mockNarrator]);
    // Book #901 (in the second chunk) is also populated
    expect(results[900]!.authors).toEqual([mockAuthor]);
    expect(results[900]!.narrators).toEqual([mockNarrator]);

    // Bounded inArray inputs: each chunk ≤ 900, partial final chunk is exactly 1.
    const authorChunks = inArrayCallsFor(bookAuthors.bookId);
    const narratorChunks = inArrayCallsFor(bookNarrators.bookId);
    expect(authorChunks).toHaveLength(2);
    expect(narratorChunks).toHaveLength(2);
    for (const chunk of [...authorChunks, ...narratorChunks]) {
      expect(chunk.length).toBeLessThanOrEqual(900);
    }
    expect(authorChunks[0]).toEqual(expectedFirstChunk);
    expect(authorChunks[1]).toEqual(expectedSecondChunk);
    expect(narratorChunks[0]).toEqual(expectedFirstChunk);
    expect(narratorChunks[1]).toEqual(expectedSecondChunk);
    expect(authorChunks[1]!.length).toBe(1);
    expect(narratorChunks[1]!.length).toBe(1);
  });

  it('getMonitoredBooks() with 1500 books splits authors/narrators into bounded chunks of 900 + 600', async () => {
    const bookRows = Array.from({ length: 1500 }, (_, i) => createMockDbBook({ id: i + 1 }));
    const expectedFirstChunk = bookRows.slice(0, 900).map((b) => b.id);
    const expectedSecondChunk = bookRows.slice(900).map((b) => b.id);
    const firstAuthorRows = bookRows.slice(0, 900).map((b) => ({ bookId: b.id, author: mockAuthor, position: 0 }));
    const secondAuthorRows = bookRows.slice(900).map((b) => ({ bookId: b.id, author: mockAuthor, position: 0 }));
    const firstNarratorRows = bookRows.slice(0, 900).map((b) => ({ bookId: b.id, narrator: mockNarrator, position: 0 }));
    const secondNarratorRows = bookRows.slice(900).map((b) => ({ bookId: b.id, narrator: mockNarrator, position: 0 }));

    db.select
      .mockReturnValueOnce(mockDbChain(bookRows))
      .mockReturnValueOnce(mockDbChain(firstAuthorRows))
      .mockReturnValueOnce(mockDbChain(secondAuthorRows))
      .mockReturnValueOnce(mockDbChain(firstNarratorRows))
      .mockReturnValueOnce(mockDbChain(secondNarratorRows));

    const results = await service.getMonitoredBooks();

    expect(db.select).toHaveBeenCalledTimes(5);
    expect(results).toHaveLength(1500);
    // Every book has its author/narrator populated — proves chunk results merged correctly
    for (const r of results) {
      expect(r.authors).toEqual([mockAuthor]);
      expect(r.narrators).toEqual([mockNarrator]);
    }

    // Bounded inArray inputs: 900 + 600 split, no chunk exceeds 900 IDs.
    const authorChunks = inArrayCallsFor(bookAuthors.bookId);
    const narratorChunks = inArrayCallsFor(bookNarrators.bookId);
    expect(authorChunks).toHaveLength(2);
    expect(narratorChunks).toHaveLength(2);
    for (const chunk of [...authorChunks, ...narratorChunks]) {
      expect(chunk.length).toBeLessThanOrEqual(900);
    }
    expect(authorChunks[0]).toEqual(expectedFirstChunk);
    expect(authorChunks[1]).toEqual(expectedSecondChunk);
    expect(narratorChunks[0]).toEqual(expectedFirstChunk);
    expect(narratorChunks[1]).toEqual(expectedSecondChunk);
    expect(authorChunks[0]!.length).toBe(900);
    expect(authorChunks[1]!.length).toBe(600);
    expect(narratorChunks[0]!.length).toBe(900);
    expect(narratorChunks[1]!.length).toBe(600);
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
    db.select.mockReturnValue(mockDbChain([{ id: 1 }]));  // author found
    db.delete.mockReturnValue(mockDbChain([]));
    db.insert.mockReturnValue(mockDbChain([]));

    await service.syncAuthors(inject<DbOrTx>(db), 10, [{ name: 'Brandon Sanderson' }, { name: 'Brandon Sanderson' }]);

    // 1 delete (clear junctions) + 1 bookAuthors insert (not 2)
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('syncNarrators replaces all narrator junctions with new list', async () => {
    db.select.mockReturnValue(mockDbChain([{ id: 5 }]));  // narrator found
    db.delete.mockReturnValue(mockDbChain([]));
    db.insert.mockReturnValue(mockDbChain([]));

    await service.syncNarrators(inject<DbOrTx>(db), 10, ['Kate Reading', 'Michael Kramer']);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(2);  // 2 bookNarrators rows
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
      // book insert + author lookup (found) + junction insert
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))  // findOrCreateAuthor: found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.create({ title: 'Test', authors: [{ name: 'Brandon Sanderson' }] });

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
    });

    it('rolls back book row when syncAuthors throws', async () => {
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book insert
      db.select
        .mockReturnValueOnce(mockDbChain([]))   // findOrCreateAuthor: not found
        .mockReturnValueOnce(mockDbChain([]));   // retry: still not found

      const failChain = mockDbChain(undefined, { error: new Error('UNIQUE constraint failed') });
      db.insert.mockReturnValueOnce(failChain);

      await expect(
        service.create({ title: 'Test', authors: [{ name: 'Ghost' }] }),
      ).rejects.toThrow('Failed to find or create author');

      // Transaction was called — Drizzle auto-rolls back on thrown error
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('rolls back book row and author junctions when syncNarrators throws', async () => {
      // book insert succeeds, syncAuthors succeeds, syncNarrators fails
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

      // No delete call on books table — compensating delete is removed
      expect(db.delete).not.toHaveBeenCalledWith(books);
    });

    it('happy path: book + authors + narrators all committed inside transaction', async () => {
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))   // findOrCreateAuthor
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // findOrCreateNarrator
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
      // insert: book + bookAuthors junction + bookNarrators junction
      expect(db.insert).toHaveBeenCalledTimes(3);
    });
  });

  describe('update() transaction wrapping', () => {
    it('wraps update + syncNarrators + syncAuthors in db.transaction()', async () => {
      db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book update returns row
      db.select
        .mockReturnValueOnce(mockDbChain([mockNarrator]))  // findOrCreateNarrator
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // findOrCreateAuthor
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
      db.update.mockReturnValueOnce(mockDbChain([]));  // no rows returned

      const result = await service.update(999, { title: 'Nope' });

      expect(result).toBeNull();
      // Transaction is still called (wraps the update), but returns false early
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('happy path: book metadata + junctions updated inside transaction', async () => {
      db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // findOrCreateAuthor
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
      tx.select.mockReturnValue(mockDbChain([{ id: 1 }]));  // author found

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson' }]);

      // tx.delete called (clear junctions), tx.insert called (junction row)
      expect(tx.delete).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(1);
      // Original db should NOT have been used for these operations
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('syncNarrators uses tx for delete and insert operations, not this.db', async () => {
      const tx = createMockDb();
      tx.select.mockReturnValue(mockDbChain([{ id: 5 }]));  // narrator found

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

      // tx.select for lookup, tx.insert for author creation + junction
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

  // ── #437 Author ASIN backfill ────────────────────────────────────────────
  describe('findOrCreateAuthor ASIN backfill (#437)', () => {
    it('backfills null ASIN on existing author when caller provides one', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor])); // found existing
      tx.update.mockReturnValueOnce(mockDbChain([]));               // ASIN update
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete
      tx.insert.mockReturnValueOnce(mockDbChain([]));               // junction insert

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }]);

      // Assert update targets the correct author row
      expect(tx.update).toHaveBeenCalledTimes(1);
      const updateChain = tx.update.mock.results[0]!.value;
      expect(updateChain.set).toHaveBeenCalledWith({ asin: 'B001IGFHW6' });
      expect(updateChain.where).toHaveBeenCalledWith(eq(authors.id, 5));

      // Assert junction insert uses the existing author ID (not a new one)
      const junctionChain = tx.insert.mock.results[0]!.value;
      expect(junctionChain.values).toHaveBeenCalledWith({ bookId: 10, authorId: 5, position: 0 });
    });

    it('does not overwrite existing non-null ASIN (first-write-wins)', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: 'B_OLD' });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor])); // found existing with ASIN
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete
      tx.insert.mockReturnValueOnce(mockDbChain([]));               // junction insert

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson', asin: 'B_NEW' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });

    it('does not update when caller provides no ASIN (undefined)', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor])); // found existing
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete
      tx.insert.mockReturnValueOnce(mockDbChain([]));               // junction insert

      await service.syncAuthors(inject<DbOrTx>(tx), 10, [{ name: 'Brandon Sanderson' }]);

      expect(tx.update).not.toHaveBeenCalled();
    });

    it('does not update when caller provides empty string ASIN', async () => {
      const tx = createMockDb();
      const existingAuthor = createMockDbAuthor({ id: 5, asin: null });
      tx.select.mockReturnValueOnce(mockDbChain([existingAuthor])); // found existing
      tx.delete.mockReturnValueOnce(mockDbChain([]));               // junction delete
      tx.insert.mockReturnValueOnce(mockDbChain([]));               // junction insert

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

      // Assert update targets the correct author row
      expect(tx.update).toHaveBeenCalledTimes(1);
      const updateChain = tx.update.mock.results[0]!.value;
      expect(updateChain.set).toHaveBeenCalledWith({ asin: 'B001IGFHW6' });
      expect(updateChain.where).toHaveBeenCalledWith(eq(authors.id, 5));

      // Assert junction insert uses the retried author ID
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

  // ── #229 Observability — CRUD log enrichment ────────────────────────────
  describe('logging improvements (#229)', () => {
    it('create log includes { authors, asin }', async () => {
      const log = createMockLogger();
      const svc = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(log));

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))    // findOrCreateAuthor
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
      // update succeeds
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      // trackUnmatchedGenres will call db.insert for unmatched genres
      const insertChain = mockDbChain([{ id: 1 }]);
      db.insert.mockReturnValue(insertChain);

      await service.update(1, { genres: ['Weird Western'] });

      // Wait for fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it('does NOT call trackUnmatchedGenres when genres are absent from update payload', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      await service.update(1, { title: 'New Title' });

      await new Promise((r) => setTimeout(r, 50));

      // db.insert should not be called (no unmatched genre tracking)
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('trackUnmatchedGenres failure during update does not reject the update promise', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      setupGetById(db);

      // Make insert (used by trackUnmatchedGenres) throw
      db.insert.mockReturnValue(mockDbChain(undefined, { error: new Error('DB write failed') }));

      // Should NOT throw — fire-and-forget catches the error
      const result = await service.update(1, { genres: ['Weird Western'] });
      expect(result).not.toBeNull();

      await new Promise((r) => setTimeout(r, 50));
    });
  });

  // #445 — uploadCover
  describe('uploadCover', () => {
    const testBuffer = Buffer.from('fake-image-data');

    function setupUploadMocks(bookPath: string | null) {
      const bookWithPath = createMockDbBook({ path: bookPath, coverUrl: null });
      // getById for initial check (3 selects)
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: bookWithPath, importListName: null }]))
        .mockReturnValueOnce(mockDbChain([{ author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));
      // writeFile + rename succeed
      (writeFile as Mock).mockResolvedValue(undefined);
      (rename as Mock).mockResolvedValue(undefined);
      // readdir for stale cleanup
      (readdir as Mock).mockResolvedValue([]);
      // DB update
      db.update.mockReturnValue(mockDbChain([bookWithPath]));
      // getById for return value (3 selects)
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

      // Should unlink cover.jpg (stale) but not cover.png (target)
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

    it('throws CoverUploadError with NO_PATH when book has no path', async () => {
      (writeFile as Mock).mockClear();
      setupUploadMocks(null);

      const err = await service.uploadCover(1, testBuffer, 'image/jpeg').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CoverUploadError);
      expect((err as CoverUploadError).code).toBe('NO_PATH');

      // No filesystem ops should have occurred
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

      // Temp file should have been written
      expect(writeFile).toHaveBeenCalled();
      // Temp file should have been cleaned up
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('.cover-upload-'));
    });

    // #477 — cover-upload edge cases
    it('still succeeds when readdir rejects (ENOENT) — .catch(() => []) fallback exercised', async () => {
      vi.mocked(readdir).mockReset();
      vi.mocked(rename).mockReset();
      vi.mocked(writeFile).mockReset();
      vi.mocked(unlink).mockReset();
      setupUploadMocks('/library/book');
      vi.mocked(readdir).mockRejectedValue(new Error('ENOENT: no such file or directory'));

      await service.uploadCover(1, testBuffer, 'image/jpeg');

      // Upload still succeeded — DB was updated
      expect(db.update).toHaveBeenCalled();
      // No stale cleanup was attempted (readdir returned empty via .catch)
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

      // Upload PNG — should try to unlink stale JPG but swallow the error
      await service.uploadCover(1, testBuffer, 'image/png');

      // Upload still succeeded — DB was updated
      expect(db.update).toHaveBeenCalled();
      // Stale cleanup was attempted for the JPG
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('cover.jpg'));
    });
  });
});
