import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { createMockDb, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { BookListService } from './book-list.service.js';
import type { Db } from '../../db/index.js';

const mockAuthor = createMockDbAuthor();
const mockBook = createMockDbBook();

describe('BookListService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookListService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookListService(inject<Db>(db));
  });

  describe('getAll', () => {
    it('returns books in { data, total } envelope', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: 'Brandon Sanderson' }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('The Way of Kings');
      expect(result.data[0].authors[0]?.name).toBe('Brandon Sanderson');
      expect(result.total).toBe(1);
    });

    it('returns empty data with total 0 when no books', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('sets authors to empty array when no join match', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result.data[0].authors).toEqual([]);
    });

    it('populates importListName via left join', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: 'My Import List', primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result.data[0].importListName).toBe('My Import List');
    });

    it('applies limit and offset when provided', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 100 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll(undefined, { limit: 10, offset: 20 });
      expect(result.total).toBe(100);
      expect(result.data).toHaveLength(1);
    });

    it('returns full unpaginated dataset when no pagination provided', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 3 }]))
        .mockReturnValueOnce(mockDbChain([
          { book: mockBook, importListName: null, primaryAuthorName: null },
          { book: { ...mockBook, id: 2 }, importListName: null, primaryAuthorName: null },
          { book: { ...mockBook, id: 3 }, importListName: null, primaryAuthorName: null },
        ]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('wanted');
      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(3);
    });

    it('composes status filter with pagination', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 25 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('wanted', { limit: 10, offset: 0 });
      expect(result.total).toBe(25);
    });

    it('slim mode excludes description and genres but retains other book columns', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.getAll(undefined, undefined, { slim: true });

      // Second db.select call is the data query (first is count)
      const selectArg = db.select.mock.calls[1][0];
      const bookColumns = selectArg.book;
      expect(bookColumns).not.toHaveProperty('description');
      expect(bookColumns).not.toHaveProperty('genres');
      // Retained columns
      expect(bookColumns).toHaveProperty('title');
      expect(bookColumns).toHaveProperty('audioDuration');
      expect(bookColumns).toHaveProperty('updatedAt');
    });

    it('non-slim mode uses the full books table selection', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.getAll(undefined, undefined, { slim: false });

      const selectArg = db.select.mock.calls[1][0];
      const bookColumns = selectArg.book;
      expect(bookColumns).toHaveProperty('description');
      expect(bookColumns).toHaveProperty('genres');
      expect(bookColumns).toHaveProperty('title');
    });

    it('applies stable orderBy with createdAt DESC, id DESC', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll();

      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args).toHaveLength(2);
    });
  });

  describe('getAll with search/sort/filter', () => {
    it('accepts search param and returns results', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll(undefined, undefined, { search: 'Kings' });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('accepts sortField and sortDirection params', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll(undefined, undefined, { sortField: 'title', sortDirection: 'asc' });
      expect(result.data).toHaveLength(1);
    });

    it('maps downloading status to searching+downloading', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('downloading', undefined);
      expect(result.total).toBe(2);
    });

    it('maps imported status to importing+imported', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 5 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('imported', undefined);
      expect(result.total).toBe(5);
    });

    it('passes wanted status as direct match', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 3 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('wanted', undefined);
      expect(result.total).toBe(3);
    });

    it('passes unknown status as direct eq() match', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('failed', undefined);
      expect(result.total).toBe(0);
      expect(result.data).toEqual([]);
    });

    it('combines search with status filter and pagination', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll('wanted', { limit: 10, offset: 0 }, { search: 'Kings' });
      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(1);
    });

    it('sorts by createdAt ascending when sortDirection=asc', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { sortField: 'createdAt', sortDirection: 'asc' });
      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args).toHaveLength(2);
    });

    it('sorts by title with leading article stripping via CASE expression', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { sortField: 'title', sortDirection: 'asc' });
      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args).toHaveLength(2);
    });

    it('applies default sort (createdAt desc) when no sortField specified', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll();
      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args).toHaveLength(2);
    });

    // #365 — search excludes narrator names
    it.todo('search filter does not include narrator EXISTS subquery in conditions');

    it('all sort fields include secondary sort by id for stable pagination', async () => {
      const sortFields = ['createdAt', 'title', 'author', 'narrator', 'series', 'quality', 'size', 'format'] as const;
      for (const sortField of sortFields) {
        const dataChain = mockDbChain([]);
        db.select
          .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
          .mockReturnValueOnce(dataChain);

        await service.getAll(undefined, undefined, { sortField, sortDirection: 'asc' });
        const args = (dataChain.orderBy as Mock).mock.calls[0];
        expect(args.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('series sort position tiebreaker (#266)', () => {
    /** Extract the trailing direction string from a Drizzle SQL clause's queryChunks. */
    function getClauseDirection(clause: { queryChunks?: unknown[] }): string | null {
      const chunks = clause.queryChunks;
      if (!Array.isArray(chunks)) return null;
      const last = chunks[chunks.length - 1] as { value?: string[] } | string;
      if (typeof last === 'string') return last.trim();
      if (last && typeof last === 'object' && Array.isArray(last.value)) return last.value[0]?.trim() ?? null;
      return null;
    }

    /** Check if a Drizzle SQL clause's queryChunks contain a given substring (handles circular refs). */
    function clauseContains(clause: { queryChunks?: unknown[] }, substring: string): boolean {
      function walk(val: unknown): boolean {
        if (typeof val === 'string') return val.includes(substring);
        if (Array.isArray(val)) return val.some(walk);
        if (val && typeof val === 'object' && 'value' in val) return walk((val as { value: unknown }).value);
        if (val && typeof val === 'object' && 'queryChunks' in val) return walk((val as { queryChunks: unknown[] }).queryChunks);
        if (val && typeof val === 'object' && 'name' in val) return walk((val as { name: unknown }).name);
        return false;
      }
      return walk(clause.queryChunks);
    }

    it('series sort asc produces 5 clauses with position always ascending and id direction-matched', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { sortField: 'series', sortDirection: 'asc' });
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args).toHaveLength(5);
      // Clause 3 (index 2): position null-flag is conditional on seriesName
      expect(clauseContains(args[2], 'series_name')).toBe(true);
      // Clause 4 (index 3): seriesPosition is always ascending
      expect(getClauseDirection(args[3])).toBe('asc');
      // Clause 5 (index 4): id tiebreaker matches sort direction (asc)
      expect(getClauseDirection(args[4])).toBe('asc');
    });

    it('series sort desc produces 5 clauses with position always ascending and id direction-matched', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { sortField: 'series', sortDirection: 'desc' });
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args).toHaveLength(5);
      // Clause 3 (index 2): position null-flag is conditional on seriesName
      expect(clauseContains(args[2], 'series_name')).toBe(true);
      // Clause 4 (index 3): seriesPosition is always ascending even for desc sort
      expect(getClauseDirection(args[3])).toBe('asc');
      // Clause 5 (index 4): id tiebreaker matches sort direction (desc)
      expect(getClauseDirection(args[4])).toBe('desc');
    });
  });

  describe('getIdentifiers', () => {
    it('returns asin, title, and author name for all books', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { asin: 'B001', title: 'Book One', authorName: 'Author A' },
        { asin: null, title: 'Book Two', authorName: null },
      ]));

      const result = await service.getIdentifiers();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ asin: 'B001', title: 'Book One', authorName: 'Author A' });
      expect(result[1]).toEqual({ asin: null, title: 'Book Two', authorName: null });
    });

    it('returns null authorName for books without authors', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { asin: 'B001', title: 'Solo Book', authorName: null },
      ]));

      const result = await service.getIdentifiers();
      expect(result[0].authorName).toBeNull();
    });

    it('returns null asin for books without ASIN', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { asin: null, title: 'No ASIN', authorName: 'Author' },
      ]));

      const result = await service.getIdentifiers();
      expect(result[0].asin).toBeNull();
    });

    it('returns empty array for empty library', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.getIdentifiers();
      expect(result).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('returns tab-model status counts with correct aggregation', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { status: 'wanted', count: 5 },
        { status: 'searching', count: 1 },
        { status: 'downloading', count: 2 },
        { status: 'importing', count: 1 },
        { status: 'imported', count: 10 },
        { status: 'failed', count: 3 },
        { status: 'missing', count: 2 },
      ]));
      db.select
        .mockReturnValueOnce(mockDbChain([{ name: 'Author A' }, { name: 'Author B' }]))
        .mockReturnValueOnce(mockDbChain([{ seriesName: 'Series A' }]))
        .mockReturnValueOnce(mockDbChain([{ name: 'Narrator A' }]));

      const stats = await service.getStats();
      expect(stats.counts.wanted).toBe(5);
      expect(stats.counts.downloading).toBe(3); // searching + downloading
      expect(stats.counts.imported).toBe(11); // importing + imported
      expect(stats.counts.failed).toBe(3);
      expect(stats.counts.missing).toBe(2);
      expect(stats.authors).toEqual(['Author A', 'Author B']);
      expect(stats.series).toEqual(['Series A']);
      expect(stats.narrators).toEqual(['Narrator A']);
    });

    it('returns zero counts and empty arrays for empty library', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const stats = await service.getStats();
      expect(stats.counts.wanted).toBe(0);
      expect(stats.counts.downloading).toBe(0);
      expect(stats.counts.imported).toBe(0);
      expect(stats.counts.failed).toBe(0);
      expect(stats.counts.missing).toBe(0);
      expect(stats.authors).toEqual([]);
      expect(stats.series).toEqual([]);
      expect(stats.narrators).toEqual([]);
    });

    it('returns unique authors without duplicates', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([{ name: 'Author A' }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const stats = await service.getStats();
      expect(stats.authors).toEqual(['Author A']);
    });

    it('excludes null and empty-string series names', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ seriesName: 'Valid Series' }]))
        .mockReturnValueOnce(mockDbChain([]));

      const stats = await service.getStats();
      // The SQL WHERE clause filters null and empty — we just verify the result shape
      expect(stats.series).toEqual(['Valid Series']);
    });

    it('excludes null and empty-string narrator values', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ name: 'Valid Narrator' }]));

      const stats = await service.getStats();
      expect(stats.narrators).toEqual(['Valid Narrator']);
    });

    it('returns string arrays for authors/series/narrators', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { status: 'wanted', count: 1 },
      ]));
      db.select
        .mockReturnValueOnce(mockDbChain([{ name: 'Author' }]))
        .mockReturnValueOnce(mockDbChain([{ seriesName: 'Series' }]))
        .mockReturnValueOnce(mockDbChain([{ name: 'Narrator' }]));

      const stats = await service.getStats();
      expect(typeof stats.authors[0]).toBe('string');
      expect(typeof stats.series[0]).toBe('string');
      expect(typeof stats.narrators[0]).toBe('string');
    });
  });
});

describe('BookListService — many-to-many authors/narrators stats and sorting (#71)', () => {
  describe('getStats() junction aggregation', () => {
    it('narrator stats list contains individual names, not comma-joined blobs', async () => {
      // Setup: 3 books with distinct narrators → narrator stats returns individual names
      const db = createMockDb();
      const service = new BookListService(inject<Db>(db));
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // status counts
        .mockReturnValueOnce(mockDbChain([]))  // author names
        .mockReturnValueOnce(mockDbChain([]))  // series
        .mockReturnValueOnce(mockDbChain([{ name: 'Michael Kramer' }, { name: 'Kate Reading' }]));  // distinct narrators from junction

      const stats = await service.getStats();
      expect(stats.narrators).toEqual(['Michael Kramer', 'Kate Reading']);
      // Not comma-joined like 'Michael Kramer, Kate Reading'
      expect(stats.narrators).not.toContain('Michael Kramer, Kate Reading');
    });

    it('two books sharing one narrator → narrator name appears once in stats list', async () => {
      // db returns just one narrator despite multiple books sharing it (GROUP BY deduplicates)
      const db = createMockDb();
      const service = new BookListService(inject<Db>(db));
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // status counts
        .mockReturnValueOnce(mockDbChain([]))  // author names
        .mockReturnValueOnce(mockDbChain([]))  // series
        .mockReturnValueOnce(mockDbChain([{ name: 'Tim Gerard Reynolds' }]));  // one entry despite 2 books

      const stats = await service.getStats();
      expect(stats.narrators).toHaveLength(1);
      expect(stats.narrators[0]).toBe('Tim Gerard Reynolds');
    });
  });

  describe('getAll() sorting by position=0', () => {
    it('sort by narrator uses position=0 entry (first narrator by metadata order)', async () => {
      const db = createMockDb();
      const service = new BookListService(inject<Db>(db));
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { sortField: 'narrator', sortDirection: 'asc' });
      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args.length).toBeGreaterThanOrEqual(3);  // null-sort + name-sort + id-sort
    });

    it('sort by author uses position=0 entry (first author by metadata order)', async () => {
      const db = createMockDb();
      const service = new BookListService(inject<Db>(db));
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { sortField: 'author', sortDirection: 'asc' });
      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as Mock).mock.calls[0];
      expect(args.length).toBeGreaterThanOrEqual(3);  // null-sort + name-sort + id-sort
    });
  });
});

describe('getIdentifiers() — authorSlug field (#133)', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookListService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookListService(inject<Db>(db));
  });

  it('returns authorSlug alongside asin, title, authorName for each book', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { asin: 'B001', title: 'Dune', authorName: 'Frank Herbert', authorSlug: 'frank-herbert' },
    ]));

    const result = await service.getIdentifiers();

    expect(result[0]).toMatchObject({
      asin: 'B001',
      title: 'Dune',
      authorName: 'Frank Herbert',
      authorSlug: 'frank-herbert',
    });
  });

  it('book with no author → authorSlug is null', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { asin: null, title: 'Unknown Book', authorName: null, authorSlug: null },
    ]));

    const result = await service.getIdentifiers();

    expect(result[0].authorSlug).toBeNull();
  });

  it('author slug matches slugify contract: J.K. Rowling → jk-rowling', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { asin: null, title: 'Harry Potter', authorName: 'J.K. Rowling', authorSlug: 'jk-rowling' },
    ]));

    const result = await service.getIdentifiers();

    expect(result[0].authorSlug).toBe('jk-rowling');
  });
});
