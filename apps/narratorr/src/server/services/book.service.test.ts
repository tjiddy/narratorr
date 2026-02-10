import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { BookService } from './book.service.js';

const now = new Date();

const mockAuthor = {
  id: 1,
  name: 'Brandon Sanderson',
  slug: 'brandon-sanderson',
  asin: null,
  imageUrl: null,
  bio: null,
  monitored: false,
  lastCheckedAt: null,
  createdAt: now,
  updatedAt: now,
};

const mockBook = {
  id: 1,
  title: 'The Way of Kings',
  authorId: 1,
  narrator: 'Michael Kramer',
  description: 'An epic fantasy',
  coverUrl: null,
  goodreadsId: null,
  audibleId: null,
  asin: null,
  isbn: null,
  seriesName: null,
  seriesPosition: null,
  duration: null,
  publishedDate: null,
  genres: null,
  status: 'wanted' as const,
  path: null,
  size: null,
  createdAt: now,
  updatedAt: now,
};

describe('BookService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookService(db as any, createMockLogger() as any);
  });

  describe('getAll', () => {
    it('returns books with authors', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: mockBook, author: mockAuthor }]),
      );

      const result = await service.getAll();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('The Way of Kings');
      expect(result[0].author?.name).toBe('Brandon Sanderson');
    });

    it('returns empty array when no books', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getAll();
      expect(result).toEqual([]);
    });

    it('sets author to undefined when no join match', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ book: mockBook, author: null }]),
      );

      const result = await service.getAll();
      expect(result[0].author).toBeUndefined();
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
});
