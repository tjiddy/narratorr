import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { BookService } from './book.service.js';
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

describe('BookService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('getAll', () => {
    it('returns books in { data, total } envelope', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor, importListName: null }]));

      const result = await service.getAll();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('The Way of Kings');
      expect(result.data[0].author?.name).toBe('Brandon Sanderson');
      expect(result.total).toBe(1);
    });

    it('returns empty data with total 0 when no books', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('sets author to undefined when no join match', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: null, importListName: null }]));

      const result = await service.getAll();
      expect(result.data[0].author).toBeUndefined();
    });

    it('applies limit and offset when provided', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 100 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor, importListName: null }]));

      const result = await service.getAll(undefined, { limit: 10, offset: 20 });
      expect(result.total).toBe(100);
      expect(result.data).toHaveLength(1);
    });

    it('composes status filter with pagination', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 25 }]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor, importListName: null }]));

      const result = await service.getAll('wanted', { limit: 10, offset: 0 });
      expect(result.total).toBe(25);
    });

    it('applies stable orderBy with createdAt DESC, id DESC', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll();

      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns book with author', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: mockBook, author: mockAuthor }]),
      );

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
      expect(result!.author?.name).toBe('Brandon Sanderson');
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('findDuplicate', () => {
    it('finds duplicate by ASIN', async () => {
      db.select.mockReturnValueOnce(
        mockDbChain([{ book: { ...mockBook, asin: 'B003P2WO5E' }, author: mockAuthor }]),
      );

      const result = await service.findDuplicate('The Way of Kings', 'Brandon Sanderson', 'B003P2WO5E');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
    });

    it('finds duplicate by title + author slug when ASIN misses', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // ASIN lookup: not found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));  // title+author: found

      const result = await service.findDuplicate('The Way of Kings', 'Brandon Sanderson', 'B000UNKNOWN');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
    });

    it('returns null when no duplicate', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // ASIN lookup
        .mockReturnValueOnce(mockDbChain([]));  // title+author lookup

      const result = await service.findDuplicate('New Book', 'New Author', 'B000NEW');
      expect(result).toBeNull();
    });

    it('skips ASIN check when not provided', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));

      const result = await service.findDuplicate('The Way of Kings', 'Brandon Sanderson');
      expect(result).not.toBeNull();
      // Only one select call (title+author), no ASIN check
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('creates book with new author', async () => {
      // First select: author lookup (not found)
      // Then insert author, then insert book, then getById
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));  // getById

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // author insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book insert

      const result = await service.create({
        title: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
      });

      expect(result.title).toBe('The Way of Kings');
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('creates book with existing author', async () => {
      // Author lookup finds existing
      db.select
        .mockReturnValueOnce(mockDbChain([mockAuthor]))  // author found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));  // getById

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));  // book insert only

      const result = await service.create({
        title: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
      });

      expect(result.title).toBe('The Way of Kings');
      expect(db.insert).toHaveBeenCalledTimes(1); // only book, not author
    });

    it('creates book without author', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: { ...mockBook, authorId: null }, author: null }]),
      );
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await service.create({ title: 'Unknown Book' });

      expect(result.title).toBe('The Way of Kings'); // from mock
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('creates book with full metadata fields', async () => {
      const fullBook = {
        ...mockBook,
        asin: 'B003P2WO5E',
        isbn: '978-0-7653-2635-5',
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        duration: 2700,
        publishedDate: '2010-08-31',
        genres: ['Fantasy', 'Epic Fantasy'],
      };

      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: fullBook, author: mockAuthor }]));  // getById

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // author insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book insert

      const result = await service.create({
        title: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
        authorAsin: 'B001IGFHW6',
        asin: 'B003P2WO5E',
        isbn: '978-0-7653-2635-5',
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        duration: 2700,
        publishedDate: '2010-08-31',
        genres: ['Fantasy', 'Epic Fantasy'],
        narrator: 'Michael Kramer, Kate Reading',
      });

      expect(result.title).toBe('The Way of Kings');
      expect(db.insert).toHaveBeenCalledTimes(2);
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
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: 'B_ENRICHED' }, author: null }]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await serviceWithMeta.create({ title: 'Test', providerId: 'hc-123' });

      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-123');
    });

    it('uses provided ASIN and skips enrichment', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: null }]));
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await serviceWithMeta.create({ title: 'Test', asin: 'B_ALREADY', providerId: 'hc-123' });

      expect(mockMetadata.getBook).not.toHaveBeenCalled();
    });

    it('creates book when getBook returns null (no ASIN found)', async () => {
      mockMetadata.getBook.mockResolvedValueOnce(null);
      // no author (no authorName), so: book insert → getById select
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, author: null }]));  // getById
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await serviceWithMeta.create({ title: 'No ASIN Book', providerId: 'hc-999' });

      expect(result.title).toBe('The Way of Kings'); // from mock
      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-999');
    });

    it('creates book when getBook returns detail without ASIN', async () => {
      mockMetadata.getBook.mockResolvedValueOnce({ title: 'Book', authors: [] });  // no asin field
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, asin: null }, author: null }]));  // getById
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await serviceWithMeta.create({ title: 'Partial Detail', providerId: 'hc-456' });

      expect(mockMetadata.getBook).toHaveBeenCalledWith('hc-456');
    });

    it('creates book when getBook throws', async () => {
      mockMetadata.getBook.mockRejectedValueOnce(new Error('API timeout'));
      db.select
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: null }]));  // getById
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await serviceWithMeta.create({ title: 'Error Book', providerId: 'hc-bad' });

      expect(result.title).toBe('The Way of Kings'); // still creates
    });
  });

  describe('trackUnmatchedGenres', () => {
    it('inserts unmatched genres into telemetry table', async () => {
      // Setup: create a book with genres that include unmatched ones
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, genres: ['Fantasy', 'Weird Western'] }, author: mockAuthor }]));  // getById

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await service.create({
        title: 'Test Book',
        authorName: 'Author',
        genres: ['Fantasy', 'Weird Western'],
      });

      // Wait for fire-and-forget to complete
      await new Promise((r) => setTimeout(r, 50));

      // "Weird Western" is not in the synonym map or known genres, so it should be tracked
      // db.insert should have been called for: author, book, and unmatched genre(s)
      expect(db.insert).toHaveBeenCalledTimes(3);
    });

    it('does not track known genres', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, genres: ['Fantasy', 'Science Fiction'] }, author: mockAuthor }]));  // getById

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await service.create({
        title: 'Test Book',
        authorName: 'Author',
        genres: ['Fantasy', 'Science Fiction'],
      });

      await new Promise((r) => setTimeout(r, 50));

      // Only author + book inserts, no unmatched genres
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('uses upsert with count increment for repeat genres', async () => {
      const insertChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: { ...mockBook, genres: ['Weird Western'] }, author: mockAuthor }]));  // getById

      db.insert.mockReturnValue(insertChain);

      await service.create({
        title: 'Test Book',
        authorName: 'Author',
        genres: ['Weird Western'],
      });

      await new Promise((r) => setTimeout(r, 50));

      // The unmatched genre insert should use onConflictDoUpdate for upsert behavior
      expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it('handles empty genres without error', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));  // getById

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));

      await service.create({
        title: 'Test Book',
        authorName: 'Author',
      });

      await new Promise((r) => setTimeout(r, 50));

      // Only author + book inserts
      expect(db.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe('update', () => {
    it('returns updated book', async () => {
      const updatedBook = { ...mockBook, title: 'Updated Title' };
      db.update.mockReturnValue(mockDbChain([updatedBook]));
      db.select.mockReturnValue(
        mockDbChain([{ book: updatedBook, author: mockAuthor }]),
      );

      const result = await service.update(1, { title: 'Updated Title' });
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Updated Title');
    });

    it('returns null when book not found', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.update(999, { title: 'Nope' });
      expect(result).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('delegates to update with status', async () => {
      db.update.mockReturnValue(mockDbChain([mockBook]));
      db.select.mockReturnValue(
        mockDbChain([{ book: { ...mockBook, status: 'downloading' }, author: mockAuthor }]),
      );

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
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns 0 when no books match status', async () => {
      db.delete.mockReturnValue(mockDbChain([]));

      const result = await service.deleteByStatus('missing');
      expect(result).toBe(0);
    });
  });

  describe('delete', () => {
    it('returns true when book exists', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: mockBook, author: mockAuthor }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns false when book not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

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
        .mockResolvedValueOnce([])   // /audiobooks/Author is empty
        .mockResolvedValueOnce([]);  // shouldn't be called — /audiobooks is library root

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      // rm called once for book dir, rmdir called once for empty Author dir
      expect(rm).toHaveBeenCalledTimes(1);
      expect(rm).toHaveBeenCalledWith('/audiobooks/Author/Book', { recursive: true, force: true });
      expect(rmdir).toHaveBeenCalledTimes(1);
      expect(rmdir).toHaveBeenCalledWith(expect.stringContaining('Author'));
    });

    it('stops cleaning parents at non-empty directory', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValueOnce(['other-book']); // Author dir has other books

      await service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks');

      // Only the book dir itself gets deleted
      expect(rm).toHaveBeenCalledTimes(1);
    });

    it('never deletes the library root', async () => {
      (rm as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue([]);

      await service.deleteBookFiles('/audiobooks/Book', '/audiobooks');

      // Only the book dir itself gets deleted — /audiobooks is root so not cleaned
      expect(rm).toHaveBeenCalledTimes(1);
      expect(rm).toHaveBeenCalledWith('/audiobooks/Book', { recursive: true, force: true });
    });

    it('skips parent cleanup when book path is not under library root', async () => {
      (rm as Mock).mockResolvedValue(undefined);

      await service.deleteBookFiles('/other-location/Book', '/audiobooks');

      // Still deletes the book dir, but no parent cleanup
      expect(rm).toHaveBeenCalledTimes(1);
      expect(readdir).not.toHaveBeenCalled();
    });

    it('skips parent cleanup when path is a prefix match but not a true descendant', async () => {
      (rm as Mock).mockResolvedValue(undefined);

      // /audiobooks2 starts with /audiobooks but is NOT a descendant
      await service.deleteBookFiles('/audiobooks2/Author/Book', '/audiobooks');

      expect(rm).toHaveBeenCalledTimes(1);
      expect(readdir).not.toHaveBeenCalled();
    });

    it('throws when rm fails', async () => {
      (rm as Mock).mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(
        service.deleteBookFiles('/audiobooks/Author/Book', '/audiobooks'),
      ).rejects.toThrow('EACCES: permission denied');
    });
  });

  describe('search', () => {
    it('returns matching books', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: mockBook, author: mockAuthor }]),
      );

      const result = await service.search('Way of Kings');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('The Way of Kings');
    });

    it('returns empty array for no matches', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.search('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('create edge cases', () => {
    it('throws when author insert succeeds but book insert fails', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]));  // author lookup (not found)

      db.insert
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]))  // author insert OK
        .mockImplementationOnce(() => { throw new Error('UNIQUE constraint failed: books.asin'); });

      await expect(
        service.create({
          title: 'The Way of Kings',
          authorName: 'Brandon Sanderson',
          asin: 'DUPLICATE_ASIN',
        }),
      ).rejects.toThrow('UNIQUE constraint failed');
    });

    it('handles concurrent author creation race condition', async () => {
      // First select: author not found
      // Author insert fails (unique constraint)
      // Retry select: author now exists
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup: not found
        .mockReturnValueOnce(mockDbChain([mockAuthor]))  // retry after constraint: found
        .mockReturnValueOnce(mockDbChain([{ book: mockBook, author: mockAuthor }]));  // getById

      const raceChain = mockDbChain();
      raceChain.then = (resolve: unknown, reject?: (err: Error) => void) => {
        return Promise.reject(new Error('UNIQUE constraint failed')).then(resolve as (v: unknown) => void, reject);
      };

      db.insert
        .mockReturnValueOnce(raceChain)  // author insert race condition
        .mockReturnValueOnce(mockDbChain([{ id: 1 }]));  // book insert OK

      const result = await service.create({
        title: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
      });

      expect(result.title).toBe('The Way of Kings');
    });

    it('throws when author race retry also fails to find author', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // author lookup: not found
        .mockReturnValueOnce(mockDbChain([]));  // retry: still not found

      const failChain2 = mockDbChain();
      failChain2.then = (resolve: unknown, reject?: (err: Error) => void) => {
        return Promise.reject(new Error('UNIQUE constraint failed')).then(resolve as (v: unknown) => void, reject);
      };
      db.insert.mockReturnValueOnce(failChain2);

      await expect(
        service.create({
          title: 'Test',
          authorName: 'Ghost Author',
        }),
      ).rejects.toThrow('Failed to find or create author');
    });
  });

  describe('findDuplicate edge cases', () => {
    it('returns null when asin is undefined (not provided)', async () => {
      // When ASIN is undefined, it should skip the ASIN check and go to title+author
      db.select.mockReturnValueOnce(mockDbChain([]));  // title+author: not found

      const result = await service.findDuplicate('Test', 'Author', undefined);
      expect(result).toBeNull();
      // Only one select call since ASIN was undefined
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('returns null when no author name provided and no ASIN', async () => {
      const result = await service.findDuplicate('Solo Title');
      expect(result).toBeNull();
    });
  });
});
