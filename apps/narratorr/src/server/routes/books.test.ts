import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { readdir, stat } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    stat: vi.fn(),
  };
});

const mockBook = {
  id: 1,
  title: 'The Way of Kings',
  authorId: 1,
  narrator: 'Michael Kramer',
  description: 'An epic fantasy',
  coverUrl: null,
  status: 'wanted',
  createdAt: new Date(),
  updatedAt: new Date(),
  author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
};

describe('books routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/books', () => {
    it('returns all books', async () => {
      (services.book.getAll as Mock).mockResolvedValue([mockBook]);

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe('The Way of Kings');
    });

    it('returns empty array when no books', async () => {
      (services.book.getAll as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });

    it('passes status query param to service', async () => {
      (services.book.getAll as Mock).mockResolvedValue([]);

      await app.inject({ method: 'GET', url: '/api/books?status=wanted' });

      expect(services.book.getAll).toHaveBeenCalledWith('wanted');
    });
  });

  describe('GET /api/books/:id', () => {
    it('returns book when found', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({ method: 'GET', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).title).toBe('The Way of Kings');
    });

    it('returns 404 when not found', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/books/999' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toBe('Book not found');
    });
  });

  describe('POST /api/books', () => {
    it('creates book and returns 201', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authorName: 'Brandon Sanderson' },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.payload).title).toBe('The Way of Kings');
    });

    it('creates book with full metadata and returns 201', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({
        ...mockBook,
        asin: 'B003P2WO5E',
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: {
          title: 'The Way of Kings',
          authorName: 'Brandon Sanderson',
          authorAsin: 'B001IGFHW6',
          asin: 'B003P2WO5E',
          isbn: '978-0-7653-2635-5',
          narrator: 'Michael Kramer, Kate Reading',
          seriesName: 'The Stormlight Archive',
          seriesPosition: 1,
          duration: 2700,
          publishedDate: '2010-08-31',
          genres: ['Fantasy'],
          description: 'An epic fantasy',
          coverUrl: 'https://example.com/cover.jpg',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'The Way of Kings',
        asin: 'B003P2WO5E',
        seriesName: 'The Stormlight Archive',
      }));
    });

    it('returns 409 when duplicate found', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authorName: 'Brandon Sanderson' },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).title).toBe('The Way of Kings');
      expect(services.book.create).not.toHaveBeenCalled();
    });

    it('returns 400 when title is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { authorName: 'Brandon Sanderson' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('passes providerId to service for ASIN enrichment', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, asin: 'B003ZWFO7E' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', providerId: '386446' },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({ providerId: '386446' }));
    });
  });

  describe('PUT /api/books/:id', () => {
    it('updates book when found', async () => {
      const updated = { ...mockBook, title: 'Updated Title' };
      (services.book.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/1',
        payload: { title: 'Updated Title' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).title).toBe('Updated Title');
    });

    it('returns 404 when not found', async () => {
      (services.book.update as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/999',
        payload: { title: 'Nope' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/books/:id', () => {
    it('deletes book and returns success', async () => {
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
      expect(services.download.getActiveByBookId).toHaveBeenCalledWith(1);
    });

    it('returns 404 when not found', async () => {
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/999' });

      expect(res.statusCode).toBe(404);
    });

    it('cancels active downloads before deleting', async () => {
      const activeDownloads = [
        { id: 10, bookId: 1, status: 'downloading' },
        { id: 11, bookId: 1, status: 'queued' },
      ];
      (services.download.getActiveByBookId as Mock).mockResolvedValue(activeDownloads);
      (services.download.cancel as Mock).mockResolvedValue(true);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(services.download.cancel).toHaveBeenCalledWith(10);
      expect(services.download.cancel).toHaveBeenCalledWith(11);
      expect(services.download.cancel).toHaveBeenCalledTimes(2);
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });
  });

  describe('GET /api/books/:id/files', () => {
    const bookWithPath = { ...mockBook, path: '/library/book1', status: 'imported' };

    it('returns audio files with sizes, filtering non-audio files', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockResolvedValue(['Chapter 01.m4b', 'Chapter 02.m4b', 'cover.jpg', 'metadata.nfo']);
      (stat as Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('Chapter 01')) return Promise.resolve({ size: 52428800 });
        return Promise.resolve({ size: 48234496 });
      });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({ name: 'Chapter 01.m4b', size: 52428800 });
      expect(body[1]).toEqual({ name: 'Chapter 02.m4b', size: 48234496 });
    });

    it('sorts files numerically (ch2 before ch10)', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockResolvedValue(['Chapter 10.m4b', 'Chapter 2.m4b', 'Chapter 1.m4b']);
      (stat as Mock).mockResolvedValue({ size: 1000 });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });

      const body = JSON.parse(res.payload);
      expect(body.map((f: { name: string }) => f.name)).toEqual([
        'Chapter 1.m4b',
        'Chapter 2.m4b',
        'Chapter 10.m4b',
      ]);
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/abc/files' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when book not found', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/books/999/files' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when book has no path', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: null });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });
      expect(res.statusCode).toBe(404);
    });

    it('returns empty array when directory has no audio files', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockResolvedValue(['cover.jpg', 'metadata.nfo']);

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });

    it('returns empty array when readdir throws (deleted directory)', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('error paths', () => {
    it('POST /api/books returns 500 when service.create throws', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockRejectedValue(new Error('DB insert failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Test Book', authorName: 'Author' },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/books/:id returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/abc' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Invalid ID');
    });

    it('PUT /api/books/:id returns 400 for NaN id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/abc',
        payload: { title: 'Test' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE /api/books/:id returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/books/abc' });
      expect(res.statusCode).toBe(400);
    });

    it('GET /api/books returns 500 when service throws', async () => {
      (services.book.getAll as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(500);
    });

    it('DELETE still succeeds when cancel() throws for one download', async () => {
      const activeDownloads = [
        { id: 10, bookId: 1, status: 'downloading' },
        { id: 11, bookId: 1, status: 'queued' },
      ];
      (services.download.getActiveByBookId as Mock).mockResolvedValue(activeDownloads);
      (services.download.cancel as Mock)
        .mockRejectedValueOnce(new Error('cancel failed'))
        .mockResolvedValueOnce(true);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });

    it('GET /api/books/:id/cover returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/abc/cover' });
      expect(res.statusCode).toBe(400);
    });

    it('GET /api/books/:id/cover returns 404 when book has no path', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: null });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(404);
    });
  });
});
