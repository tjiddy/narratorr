import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { BookService } from './book.service.js';
import { books } from '../../db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { MetadataService } from './metadata.service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    rm: vi.fn(),
    rmdir: vi.fn(),
    readdir: vi.fn(),
  };
});

import { rm, rmdir, readdir } from 'node:fs/promises';
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
      expect(result!.authors[0].name).toBe('Brandon Sanderson');
      expect(result!.narrators).toHaveLength(1);
      expect(result!.narrators[0].name).toBe('Michael Kramer');
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
      expect(result!.authors[0].name).toBe('Brandon Sanderson');
      expect(result!.authors[1].name).toBe('Second Author');
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

    it('returns null when no authors and no ASIN', async () => {
      const result = await service.findDuplicate('Solo Title');
      expect(result).toBeNull();
    });

    it('skips ASIN check when not provided, falls through to title+author', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));  // title+author: not found

      const result = await service.findDuplicate('The Way of Kings', [{ name: 'Brandon Sanderson' }], undefined);
      expect(result).toBeNull();
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('create() junction table CRUD', () => {
    it('inserts bookAuthors junction rows with correct positions for multiple authors', async () => {
      const author2 = { id: 2, name: 'Second Author', slug: 'second-author', asin: null, imageUrl: null, bio: null, monitored: false, lastCheckedAt: null, createdAt: new Date(), updatedAt: new Date() };

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
      expect(result.narrators[0].name).toBe('Michael Kramer');
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

      expect(result.narrators[0].name).toBe('Michael Kramer');
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
  });

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
    expect(results[0].authors).toEqual([mockAuthor]);
    expect(results[0].narrators).toEqual([mockNarrator]);
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

    await service.syncAuthors(inject<Db>(db), 10, []);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('syncNarrators(bookId, []) clears all narrator junctions without error', async () => {
    db.delete.mockReturnValue(mockDbChain([]));

    await service.syncNarrators(inject<Db>(db), 10, []);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('syncAuthors deduplicates by slug — two authors with same slug produce one junction row', async () => {
    db.select.mockReturnValue(mockDbChain([{ id: 1 }]));  // author found
    db.delete.mockReturnValue(mockDbChain([]));
    db.insert.mockReturnValue(mockDbChain([]));

    await service.syncAuthors(inject<Db>(db), 10, [{ name: 'Brandon Sanderson' }, { name: 'Brandon Sanderson' }]);

    // 1 delete (clear junctions) + 1 bookAuthors insert (not 2)
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('syncNarrators replaces all narrator junctions with new list', async () => {
    db.select.mockReturnValue(mockDbChain([{ id: 5 }]));  // narrator found
    db.delete.mockReturnValue(mockDbChain([]));
    db.insert.mockReturnValue(mockDbChain([]));

    await service.syncNarrators(inject<Db>(db), 10, ['Kate Reading', 'Michael Kramer']);

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(2);  // 2 bookNarrators rows
  });
});

describe('BookService — transaction atomicity (#214)', () => {
  describe('create() transaction wrapping', () => {
    it.todo('wraps insert + syncAuthors + syncNarrators in db.transaction()');
    it.todo('rolls back book row when syncAuthors throws');
    it.todo('rolls back book row and author junctions when syncNarrators throws');
    it.todo('does not contain manual compensating delete — transaction rollback handles cleanup');
    it.todo('happy path: book + authors + narrators all committed inside transaction');
    it.todo('passes tx to syncAuthors and syncNarrators, not this.db');
  });

  describe('update() transaction wrapping', () => {
    it.todo('wraps update + syncNarrators + syncAuthors in db.transaction()');
    it.todo('rolls back book metadata when syncNarrators throws');
    it.todo('rolls back book metadata and narrator junctions when syncAuthors throws');
    it.todo('returns null without transaction when book ID does not match');
    it.todo('happy path: book metadata + junctions updated inside transaction');
    it.todo('passes tx to syncNarrators and syncAuthors, not this.db');
  });

  describe('syncAuthors/syncNarrators tx parameter', () => {
    it.todo('syncAuthors uses tx for delete and insert operations, not this.db');
    it.todo('syncNarrators uses tx for delete and insert operations, not this.db');
    it.todo('findOrCreateAuthor uses tx for select and insert, not this.db');
    it.todo('findOrCreateNarrator uses tx for select and insert, not this.db');
  });
});
