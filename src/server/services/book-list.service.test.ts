import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { createMockDb, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { BookListService } from './book-list.service.js';
import type { Db } from '../../db/index.js';
import { BOOK_STATUSES, LIBRARY_FILTER_BUCKETS, type LibraryFilterBucket, type BookStatus } from '../../shared/schemas/book.js';

// Serialize a Drizzle SQL expression to a raw SQL string + bound params so the
// bucket-expansion predicate can be asserted against real SQL, not mock calls
// (mirrors blacklist.service.test.ts).
const dialect = new SQLiteSyncDialect();
function compileWhere(expr: unknown): { sql: string; params: unknown[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL());
}

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
      expect(result.data[0]!.title).toBe('The Way of Kings');
      expect(result.data[0]!.authors[0]?.name).toBe('Brandon Sanderson');
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
      expect(result.data[0]!.authors).toEqual([]);
    });

    it('populates importListName via left join', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, importListName: 'My Import List', primaryAuthorName: null }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result.data[0]!.importListName).toBe('My Import List');
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
      const selectArg = db.select.mock.calls[1]![0];
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

      const selectArg = db.select.mock.calls[1]![0];
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

    // #365 — search excludes narrator names but retains title/series/genres/author
    it('search filter excludes narrator subquery but retains series_name, genres, and author subquery', async () => {
      const countChain = mockDbChain([{ value: 1 }]);
      const dataChain = mockDbChain([{ book: mockBook, importListName: null, primaryAuthorName: null }]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain)
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, author: mockAuthor, position: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.getAll(undefined, undefined, { search: 'test' });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      function containsSubstring(val: unknown, substring: string): boolean {
        if (typeof val === 'string') return val.includes(substring);
        if (Array.isArray(val)) return val.some((v) => containsSubstring(v, substring));
        if (val && typeof val === 'object') {
          if ('queryChunks' in val) return containsSubstring((val as { queryChunks: unknown[] }).queryChunks, substring);
          if ('value' in val) return containsSubstring((val as { value: unknown }).value, substring);
          if ('name' in val) return containsSubstring((val as { name: unknown }).name, substring);
        }
        return false;
      }
      // Narrator subquery removed
      expect(containsSubstring(whereArg, 'book_narrators')).toBe(false);
      // Retained clauses still present
      expect(containsSubstring(whereArg, 'series_name')).toBe(true);
      expect(containsSubstring(whereArg, 'genres')).toBe(true);
      expect(containsSubstring(whereArg, 'book_authors')).toBe(true);
    });

    function containsSubstring(val: unknown, substring: string): boolean {
      if (typeof val === 'string') return val.includes(substring);
      if (Array.isArray(val)) return val.some((v) => containsSubstring(v, substring));
      if (val && typeof val === 'object') {
        if ('queryChunks' in val) return containsSubstring((val as { queryChunks: unknown[] }).queryChunks, substring);
        if ('value' in val) return containsSubstring((val as { value: unknown }).value, substring);
        if ('name' in val) return containsSubstring((val as { name: unknown }).name, substring);
      }
      return false;
    }

    it('author filter emits case-insensitive EXISTS subquery on book_authors (#1143)', async () => {
      const countChain = mockDbChain([{ value: 1 }]);
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { author: 'Brandon Sanderson' });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(containsSubstring(whereArg, 'book_authors')).toBe(true);
      expect(containsSubstring(whereArg, 'lower(')).toBe(true);
    });

    it('series filter emits case-insensitive series_name comparison (#1143)', async () => {
      const countChain = mockDbChain([{ value: 1 }]);
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { series: 'The Stormlight Archive' });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(containsSubstring(whereArg, 'series_name')).toBe(true);
      expect(containsSubstring(whereArg, 'lower(')).toBe(true);
    });

    it('narrator filter emits case-insensitive EXISTS subquery on book_narrators (#1143)', async () => {
      const countChain = mockDbChain([{ value: 1 }]);
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain);

      await service.getAll(undefined, undefined, { narrator: 'Michael Kramer' });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(containsSubstring(whereArg, 'book_narrators')).toBe(true);
      expect(containsSubstring(whereArg, 'lower(')).toBe(true);
    });

    it('combined author + status filters both appear in WHERE (#1143)', async () => {
      const countChain = mockDbChain([{ value: 1 }]);
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain);

      await service.getAll('imported', undefined, { author: 'Sanderson' });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(containsSubstring(whereArg, 'book_authors')).toBe(true);
      expect(containsSubstring(whereArg, 'status')).toBe(true);
    });

    it('all sort fields include secondary sort by id for stable pagination', async () => {
      const sortFields = ['createdAt', 'title', 'author', 'narrator', 'series', 'quality', 'size', 'format'] as const;
      for (const sortField of sortFields) {
        const dataChain = mockDbChain([]);
        db.select
          .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
          .mockReturnValueOnce(dataChain);

        await service.getAll(undefined, undefined, { sortField, sortDirection: 'asc' });
        const args = (dataChain.orderBy as Mock).mock.calls[0];
        expect(args!.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  // #1447 (S2d / F1) — pin the actual SQL `buildListWhere` generates for each
  // library bucket. The earlier getAll('downloading') tests only assert mocked
  // totals, so they'd still pass if the bucket branch regressed to
  // `eq(books.status, status)`. Compiling the captured predicate and asserting it
  // is an `IN (...)` over the bucket's exact member statuses catches that
  // regression directly (an `eq` would drop the second member and emit `= ?`).
  describe('buildListWhere bucket expansion — generated SQL (#1447 / F1)', () => {
    /** Capture the WHERE clause `getAllForLibrary` passes to the count query. */
    async function captureLibraryWhere(bucket: LibraryFilterBucket) {
      const countChain = mockDbChain([{ value: 0 }]);
      const rowsChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(rowsChain);

      await service.getAllForLibrary(bucket);

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(whereArg).toBeDefined();
      return compileWhere(whereArg);
    }

    for (const bucket of Object.keys(LIBRARY_FILTER_BUCKETS) as LibraryFilterBucket[]) {
      const members = [...LIBRARY_FILTER_BUCKETS[bucket]];

      it(`expands bucket "${bucket}" to an IN over exactly [${members.join(', ')}]`, async () => {
        const { sql, params } = await captureLibraryWhere(bucket);

        // IN-expansion, not an `eq` — a regression to `eq(books.status, status)`
        // would emit `"status" = ?` and fail this assertion.
        expect(sql.toLowerCase()).toContain('"status" in (');
        expect(sql.toLowerCase()).not.toContain('"status" = ');
        // Bound params are exactly the canonical member statuses of the bucket.
        expect(params).toEqual(members);
      });
    }

    it('multi-member buckets bind every member (not just the first)', async () => {
      const { params } = await captureLibraryWhere('downloading');
      expect(params).toEqual(['searching', 'downloading']);
      expect(params).toHaveLength(2);
    });
  });

  // #1449 (S3 / F1) — the native `/api/v1` boundary needs EXACT canonical-status
  // semantics, not the library bucket expansion. The additive `exactStatus` option
  // on getAll() forces `eq(books.status, status)` and skips BUCKET_EXPANSION, so a
  // canonical `downloading`/`imported` filters to that exact state instead of
  // silently widening to the bucket. Default (omitted/false) keeps legacy behavior.
  describe('getAll exactStatus option — exact canonical match (#1449)', () => {
    /** Capture the WHERE clause `getAll` passes to its count query. */
    async function captureGetAllWhere(status: BookStatus, exactStatus: boolean) {
      const countChain = mockDbChain([{ value: 0 }]);
      const rowsChain = mockDbChain([]);
      db.select.mockReturnValueOnce(countChain).mockReturnValueOnce(rowsChain);

      await service.getAll(status, undefined, { exactStatus });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(whereArg).toBeDefined();
      return compileWhere(whereArg);
    }

    it('forces an exact eq match for the overlapping bucket key "downloading"', async () => {
      const { sql, params } = await captureGetAllWhere('downloading', true);
      expect(sql.toLowerCase()).toContain('"status" = ');
      expect(sql.toLowerCase()).not.toContain('"status" in (');
      expect(params).toEqual(['downloading']);
    });

    it('forces an exact eq match for "imported" (no importing+imported expansion)', async () => {
      const { sql, params } = await captureGetAllWhere('imported', true);
      expect(sql.toLowerCase()).toContain('"status" = ');
      expect(sql.toLowerCase()).not.toContain('"status" in (');
      expect(params).toEqual(['imported']);
    });

    it('default (exactStatus false) still bucket-expands "downloading" → searching+downloading', async () => {
      const { sql, params } = await captureGetAllWhere('downloading', false);
      expect(sql.toLowerCase()).toContain('"status" in (');
      expect(params).toEqual(['searching', 'downloading']);
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
      expect(clauseContains(args![2], 'series_name')).toBe(true);
      // Clause 4 (index 3): seriesPosition is always ascending
      expect(getClauseDirection(args![3])).toBe('asc');
      // Clause 5 (index 4): id tiebreaker matches sort direction (asc)
      expect(getClauseDirection(args![4])).toBe('asc');
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
      expect(clauseContains(args![2], 'series_name')).toBe(true);
      // Clause 4 (index 3): seriesPosition is always ascending even for desc sort
      expect(getClauseDirection(args![3])).toBe('asc');
      // Clause 5 (index 4): id tiebreaker matches sort direction (desc)
      expect(getClauseDirection(args![4])).toBe('desc');
    });
  });

  describe('getAllForLibrary (#1132)', () => {
    it('returns { data, total } envelope with the slim DTO shape', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{
          id: 1, title: 'The Way of Kings', coverUrl: null, status: 'wanted',
          seriesName: null, seriesPosition: null,
          audioTotalSize: null, size: null, audioFileFormat: null,
          audioDuration: null, duration: null, path: null, audioFileCount: null,
          lastGrabGuid: null, lastGrabInfoHash: null,
          createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01'),
        }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, name: 'Brandon Sanderson', position: 0 }]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, name: 'Michael Kramer', position: 0 }]));

      const result = await service.getAllForLibrary();
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      const row = result.data[0]!;
      // Required DTO keys present
      const expectedKeys = new Set([
        'id', 'title', 'coverUrl', 'status', 'seriesName', 'seriesPosition',
        'authors', 'narrators',
        'audioTotalSize', 'size', 'audioFileFormat', 'audioDuration', 'duration',
        'path', 'audioFileCount', 'lastGrabGuid', 'lastGrabInfoHash',
        'createdAt', 'updatedAt',
      ]);
      for (const k of expectedKeys) expect(row).toHaveProperty(k);
      // Trimmed keys absent
      const trimmedKeys = ['audioCodec', 'audioBitrate', 'audioSampleRate', 'audioChannels', 'audioBitrateMode', 'topLevelAudioFileCount', 'isbn', 'asin', 'description', 'publishedDate', 'enrichmentStatus', 'importListId', 'importListName', 'genres'];
      for (const k of trimmedKeys) expect(row).not.toHaveProperty(k);
      // Author/narrator entries are name-only
      expect(row.authors).toEqual([{ name: 'Brandon Sanderson' }]);
      expect(row.narrators).toEqual([{ name: 'Michael Kramer' }]);
    });

    it('returns empty data with total 0 when no books match', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('returns empty authors/narrators arrays when a book has none', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{
          id: 1, title: 'Solo', coverUrl: null, status: 'wanted',
          seriesName: null, seriesPosition: null,
          audioTotalSize: null, size: null, audioFileFormat: null,
          audioDuration: null, duration: null, path: null, audioFileCount: null,
          lastGrabGuid: null, lastGrabInfoHash: null,
          createdAt: new Date(), updatedAt: new Date(),
        }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary();
      expect(result.data[0]!.authors).toEqual([]);
      expect(result.data[0]!.narrators).toEqual([]);
    });

    it('preserves position order across multiple authors/narrators', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{
          id: 1, title: 'Co-authored', coverUrl: null, status: 'wanted',
          seriesName: null, seriesPosition: null,
          audioTotalSize: null, size: null, audioFileFormat: null,
          audioDuration: null, duration: null, path: null, audioFileCount: null,
          lastGrabGuid: null, lastGrabInfoHash: null,
          createdAt: new Date(), updatedAt: new Date(),
        }]))
        // Return authors in shuffled order — service must sort by position
        .mockReturnValueOnce(mockDbChain([
          { bookId: 1, name: 'Second Author', position: 1 },
          { bookId: 1, name: 'Primary Author', position: 0 },
        ]))
        .mockReturnValueOnce(mockDbChain([
          { bookId: 1, name: 'Narrator B', position: 1 },
          { bookId: 1, name: 'Narrator A', position: 0 },
        ]));

      const result = await service.getAllForLibrary();
      expect(result.data[0]!.authors.map((a) => a.name)).toEqual(['Primary Author', 'Second Author']);
      expect(result.data[0]!.narrators.map((n) => n.name)).toEqual(['Narrator A', 'Narrator B']);
    });

    it('search WHERE excludes book_narrators subquery (parity with /api/books per #365)', async () => {
      const countChain = mockDbChain([{ value: 1 }]);
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain);

      await service.getAllForLibrary(undefined, undefined, { search: 'test' });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      function containsSubstring(val: unknown, substring: string): boolean {
        if (typeof val === 'string') return val.includes(substring);
        if (Array.isArray(val)) return val.some((v) => containsSubstring(v, substring));
        if (val && typeof val === 'object') {
          if ('queryChunks' in val) return containsSubstring((val as { queryChunks: unknown[] }).queryChunks, substring);
          if ('value' in val) return containsSubstring((val as { value: unknown }).value, substring);
          if ('name' in val) return containsSubstring((val as { name: unknown }).name, substring);
        }
        return false;
      }
      expect(containsSubstring(whereArg, 'book_narrators')).toBe(false);
      expect(containsSubstring(whereArg, 'series_name')).toBe(true);
      expect(containsSubstring(whereArg, 'genres')).toBe(true);
      expect(containsSubstring(whereArg, 'book_authors')).toBe(true);
    });

    it('author/series/narrator filters reach the shared predicate on the library endpoint (#1143)', async () => {
      function containsSubstring(val: unknown, substring: string): boolean {
        if (typeof val === 'string') return val.includes(substring);
        if (Array.isArray(val)) return val.some((v) => containsSubstring(v, substring));
        if (val && typeof val === 'object') {
          if ('queryChunks' in val) return containsSubstring((val as { queryChunks: unknown[] }).queryChunks, substring);
          if ('value' in val) return containsSubstring((val as { value: unknown }).value, substring);
          if ('name' in val) return containsSubstring((val as { name: unknown }).name, substring);
        }
        return false;
      }

      const countChain = mockDbChain([{ value: 0 }]);
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(dataChain);

      await service.getAllForLibrary(undefined, undefined, {
        author: 'Brandon Sanderson',
        series: 'The Stormlight Archive',
        narrator: 'Michael Kramer',
      });

      const whereArg = (countChain.where as Mock).mock.calls[0]?.[0];
      expect(containsSubstring(whereArg, 'book_authors')).toBe(true);
      expect(containsSubstring(whereArg, 'series_name')).toBe(true);
      expect(containsSubstring(whereArg, 'book_narrators')).toBe(true);
    });

    it('reuses buildOrderBy — sort fields produce ≥2 order clauses (stable pagination)', async () => {
      const sortFields = ['createdAt', 'title', 'author', 'narrator', 'series', 'quality', 'size', 'format'] as const;
      for (const sortField of sortFields) {
        const dataChain = mockDbChain([]);
        db.select
          .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
          .mockReturnValueOnce(dataChain);
        await service.getAllForLibrary(undefined, undefined, { sortField, sortDirection: 'asc' });
        const args = (dataChain.orderBy as Mock).mock.calls[0];
        expect(args!.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('applies limit and offset', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 100 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAllForLibrary(undefined, { limit: 10, offset: 20 });
      expect(dataChain.limit).toHaveBeenCalledWith(10);
      expect(dataChain.offset).toHaveBeenCalledWith(20);
    });

    it('selects only the slim column set — heavy columns are absent from the SELECT', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      await service.getAllForLibrary();

      const selectArg = db.select.mock.calls[1]![0];
      const keys = Object.keys(selectArg);
      // Required slim columns
      for (const k of ['id', 'title', 'coverUrl', 'status', 'seriesName', 'seriesPosition', 'audioTotalSize', 'size', 'audioFileFormat', 'audioDuration', 'duration', 'path', 'audioFileCount', 'lastGrabGuid', 'lastGrabInfoHash', 'createdAt', 'updatedAt']) {
        expect(keys).toContain(k);
      }
      // Trimmed columns
      for (const k of ['description', 'genres', 'audioCodec', 'audioBitrate', 'audioSampleRate', 'audioChannels', 'audioBitrateMode', 'topLevelAudioFileCount', 'isbn', 'asin', 'enrichmentStatus', 'importListId', 'publishedDate']) {
        expect(keys).not.toContain(k);
      }
    });
  });

  describe('getAllForLibrary — collapse (#1169)', () => {
    function makeRow(overrides: Partial<{ id: number; title: string; seriesName: string | null; seriesPosition: number | null; status: string; createdAt: Date; audioTotalSize: number | null; size: number | null; audioDuration: number | null; duration: number | null }>) {
      return {
        id: overrides.id ?? 1,
        title: overrides.title ?? 'Book',
        coverUrl: null,
        status: overrides.status ?? 'imported',
        seriesName: overrides.seriesName ?? null,
        seriesPosition: overrides.seriesPosition ?? null,
        audioTotalSize: overrides.audioTotalSize ?? null,
        size: overrides.size ?? null,
        audioFileFormat: null,
        audioDuration: overrides.audioDuration ?? null,
        duration: overrides.duration ?? null,
        path: null,
        audioFileCount: null,
        lastGrabGuid: null,
        lastGrabInfoHash: null,
        createdAt: overrides.createdAt ?? new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
    }

    it('groups books by seriesName and returns representative with collapsedCount', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, title: 'Book 1', seriesName: 'Stormlight', seriesPosition: 1 }),
          makeRow({ id: 2, title: 'Book 2', seriesName: 'Stormlight', seriesPosition: 2 }),
          makeRow({ id: 3, title: 'Book 3', seriesName: 'Stormlight', seriesPosition: 3 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.id).toBe(1);
      expect(result.data[0]!.collapsedCount).toBe(2);
    });

    it('standalones are returned individually without collapsedCount', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, title: 'Standalone', seriesName: null }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.collapsedCount).toBeUndefined();
    });

    it('empty-string seriesName treated as standalone', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, title: 'Empty Series', seriesName: '' }),
          makeRow({ id: 2, title: 'Null Series', seriesName: null }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
    });

    it('single-book series returns collapsedCount 0', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, seriesName: 'Solo Series', seriesPosition: 1 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.data[0]!.collapsedCount).toBe(0);
    });

    it('picks lowest non-null seriesPosition as representative', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 3, seriesName: 'WoT', seriesPosition: 3 }),
          makeRow({ id: 1, seriesName: 'WoT', seriesPosition: 1 }),
          makeRow({ id: 2, seriesName: 'WoT', seriesPosition: 2 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.data[0]!.id).toBe(1);
    });

    it('falls back to first-by-sort when no books have seriesPosition', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 5, seriesName: 'NoPos', seriesPosition: null }),
          makeRow({ id: 3, seriesName: 'NoPos', seriesPosition: null }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.data[0]!.id).toBe(5);
    });

    it('total reflects collapsed count (series groups + standalones)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, seriesName: 'Series A', seriesPosition: 1, createdAt: new Date('2024-01-05') }),
          makeRow({ id: 2, seriesName: 'Series A', seriesPosition: 2, createdAt: new Date('2024-01-04') }),
          makeRow({ id: 3, seriesName: 'Series B', seriesPosition: 1, createdAt: new Date('2024-01-03') }),
          makeRow({ id: 4, seriesName: null, createdAt: new Date('2024-01-02') }),
          makeRow({ id: 5, seriesName: null, createdAt: new Date('2024-01-01') }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result.total).toBe(4);
    });

    it('pagination operates on collapsed result', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, seriesName: 'Series A', seriesPosition: 1, createdAt: new Date('2024-01-05') }),
          makeRow({ id: 2, seriesName: 'Series A', seriesPosition: 2, createdAt: new Date('2024-01-04') }),
          makeRow({ id: 3, seriesName: null, createdAt: new Date('2024-01-03') }),
          makeRow({ id: 4, seriesName: null, createdAt: new Date('2024-01-02') }),
          makeRow({ id: 5, seriesName: null, createdAt: new Date('2024-01-01') }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, { limit: 2, offset: 0 }, { collapse: true });
      expect(result.total).toBe(4);
      expect(result.data).toHaveLength(2);
    });

    it('returns empty result for no matches', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: true });
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('quality sort with audioDuration=0 falls back to duration field', async () => {
      // Book 1: 360 MB / (600 min → 36000 sec) ≈ 10 MB/hr (low quality)
      // Book 2: 100 MB / 3600 sec ≈ 28 MB/hr (higher quality)
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, seriesName: null, audioTotalSize: 360 * 1024 * 1024, audioDuration: 0, duration: 600 }),
          makeRow({ id: 2, seriesName: null, audioTotalSize: 100 * 1024 * 1024, audioDuration: 3600 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, {
        collapse: true, sortField: 'quality', sortDirection: 'asc',
      });
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.id).toBe(1);
      expect(result.data[1]!.id).toBe(2);
    });

    it('no-position quality fallback picks representative using resolveBookQualityInputs semantics', async () => {
      // Book 1: audioDuration=0 but duration=600 → resolveBookQualityInputs falls back to 36000s → low quality
      // Book 2: audioDuration=3600 → 3600s → higher quality
      // DB ORDER BY would treat audioDuration=0 as COALESCE(0, duration)=0 → invalid, so SQL puts it last.
      // But resolveBookQualityInputs treats 0 as falsy → falls back to duration*60=36000 → valid.
      // With asc quality sort, book 1 (lower quality) should be representative.
      db.select
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 2, seriesName: 'S', seriesPosition: null, audioTotalSize: 100 * 1024 * 1024, audioDuration: 3600 }),
          makeRow({ id: 1, seriesName: 'S', seriesPosition: null, audioTotalSize: 360 * 1024 * 1024, audioDuration: 0, duration: 600 }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, {
        collapse: true, sortField: 'quality', sortDirection: 'asc',
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.id).toBe(1);
      expect(result.data[0]!.collapsedCount).toBe(1);
    });

    it('collapse=false returns individual books (non-collapse path)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 3 }]))
        .mockReturnValueOnce(mockDbChain([
          makeRow({ id: 1, seriesName: 'S', seriesPosition: 1 }),
          makeRow({ id: 2, seriesName: 'S', seriesPosition: 2 }),
          makeRow({ id: 3, seriesName: null }),
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAllForLibrary(undefined, undefined, { collapse: false });
      expect(result.total).toBe(3);
      expect(result.data).toHaveLength(3);
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
      expect(result[0]!.authorName).toBeNull();
    });

    it('returns null asin for books without ASIN', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { asin: null, title: 'No ASIN', authorName: 'Author' },
      ]));

      const result = await service.getIdentifiers();
      expect(result[0]!.asin).toBeNull();
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

    // #1447 (S2d) — counts are derived from LIBRARY_FILTER_BUCKETS, so every
    // canonical status contributes to exactly one bucket and the per-bucket sums
    // are driven by the map rather than hardcoded pairs.
    it('returns one entry per LIBRARY_FILTER_BUCKETS key, each summing its canonical states', async () => {
      // Distinct per-status counts so a mis-summed bucket is detectable.
      const perStatus: Record<string, number> = {
        wanted: 5, searching: 1, downloading: 2, importing: 3, imported: 10, failed: 4, missing: 2,
      };
      db.select.mockReturnValueOnce(mockDbChain(
        BOOK_STATUSES.map((status) => ({ status, count: perStatus[status] })),
      ));
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const stats = await service.getStats();

      // Exactly the bucket keys, nothing else.
      expect(Object.keys(stats.counts).sort()).toEqual(Object.keys(LIBRARY_FILTER_BUCKETS).sort());

      // Each bucket equals the sum of its canonical member states.
      for (const bucket of Object.keys(LIBRARY_FILTER_BUCKETS) as LibraryFilterBucket[]) {
        const expected = LIBRARY_FILTER_BUCKETS[bucket].reduce((sum, s) => sum + perStatus[s]!, 0);
        expect(stats.counts[bucket]).toBe(expected);
      }

      // No status is silently uncounted: the bucket totals sum to the grand total.
      const grandTotal = Object.values(perStatus).reduce((a, b) => a + b, 0);
      const bucketTotal = Object.values(stats.counts).reduce((a, b) => a + b, 0);
      expect(bucketTotal).toBe(grandTotal);
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
      expect(args!.length).toBeGreaterThanOrEqual(3);  // null-sort + name-sort + id-sort
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
      expect(args!.length).toBeGreaterThanOrEqual(3);  // null-sort + name-sort + id-sort
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

    expect(result[0]!.authorSlug).toBeNull();
  });

  it('author slug matches slugify contract: J.K. Rowling → jk-rowling', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { asin: null, title: 'Harry Potter', authorName: 'J.K. Rowling', authorSlug: 'jk-rowling' },
    ]));

    const result = await service.getIdentifiers();

    expect(result[0]!.authorSlug).toBe('jk-rowling');
  });
});
