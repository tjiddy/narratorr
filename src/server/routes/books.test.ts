import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import type { Services } from './index.js';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';
import { MergeError } from '../services/merge.service.js';
import { readdir, readFile, stat } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
  };
});

const mockBook = {
  ...createMockDbBook(),
  authors: [createMockDbAuthor()],
  narrators: [],
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
    it('returns books in { data, total } envelope', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [mockBook], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('The Way of Kings');
      expect(body.total).toBe(1);
    });

    it('returns empty data when no books', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ data: [], total: 0 });
    });

    it('passes status and slim option to service', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?status=wanted' });

      expect(services.bookList.getAll).toHaveBeenCalledWith('wanted', { limit: 100, offset: undefined }, { slim: true, search: undefined, sortField: undefined, sortDirection: undefined });
    });

    it('forwards limit and offset to service', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?limit=10&offset=20' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(undefined, { limit: 10, offset: 20 }, { slim: true, search: undefined, sortField: undefined, sortDirection: undefined });
    });

    it('rejects limit=0 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?limit=0' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects limit=501 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?limit=501' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative offset with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?offset=-1' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-integer limit with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?limit=abc' });
      expect(res.statusCode).toBe(400);
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
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
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
          authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
          asin: 'B003P2WO5E',
          isbn: '978-0-7653-2635-5',
          narrators: ['Michael Kramer', 'Kate Reading'],
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
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
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

    it('triggers search when searchImmediately is true and status is wanted', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.quality);
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);

      // Wait for fire-and-forget promise to resolve
      await new Promise(r => setTimeout(r, 50));

      expect(services.settings.get).toHaveBeenCalledWith('quality');
      expect(services.indexer.searchAll).toHaveBeenCalled();
      expect(services.downloadOrchestrator.grab).toHaveBeenCalled();
    });

    it('fire-and-forget search excludes results matching reject words', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue({
        grabFloor: 0, minSeeders: 0, protocolPreference: 'none',
        rejectWords: 'abridged',
        requiredWords: '',
      });
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings Abridged', rawTitle: 'The Way of Kings Abridged', downloadUrl: 'https://example.com/dl1', protocol: 'torrent', size: 500000, seeders: 10 },
        { title: 'The Way of Kings', rawTitle: 'The Way of Kings Full', downloadUrl: 'https://example.com/dl2', protocol: 'torrent', size: 500000, seeders: 5 },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);
      await new Promise(r => setTimeout(r, 50));

      expect(services.downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: 'https://example.com/dl2' }),
      );
    });

    it('fire-and-forget search skips grab when no results match required words', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue({
        grabFloor: 0, minSeeders: 0, protocolPreference: 'none',
        rejectWords: '',
        requiredWords: 'unabridged',
      });
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings', rawTitle: 'The Way of Kings MP3', downloadUrl: 'https://example.com/dl1', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);
      await new Promise(r => setTimeout(r, 50));

      expect(services.downloadOrchestrator.grab).not.toHaveBeenCalled();
    });

    it('does not trigger search when searchImmediately is false', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: false },
      });

      expect(res.statusCode).toBe(201);
      expect(services.indexer.searchAll).not.toHaveBeenCalled();
    });

    it('does not trigger search when searchImmediately is not provided', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
      });

      expect(res.statusCode).toBe(201);
      expect(services.indexer.searchAll).not.toHaveBeenCalled();
    });

    it('search trigger failure does not fail book creation', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.quality);
      (services.indexer.searchAll as Mock).mockRejectedValue(new Error('Indexer down'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);

      // Wait for fire-and-forget to settle
      await new Promise(r => setTimeout(r, 50));
    });

    it('does not trigger search when book status is not wanted', async () => {
      const importedBook = { ...mockBook, status: 'imported' };
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(importedBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);
      expect(services.indexer.searchAll).not.toHaveBeenCalled();
    });

    it('passes monitorForUpgrades to create service', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, monitorForUpgrades: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], monitorForUpgrades: true },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({ monitorForUpgrades: true }));
    });

    it('defaults monitorForUpgrades to undefined when not provided', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.create).toHaveBeenCalled();
    });

    it('passes providerId to service for ASIN enrichment', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, asin: 'B003ZWFO7E' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], providerId: '386446' },
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

    it('accepts and persists seriesName and seriesPosition', async () => {
      const updated = { ...mockBook, seriesName: 'Stormlight', seriesPosition: 1 };
      (services.book.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/1',
        payload: { seriesName: 'Stormlight', seriesPosition: 1 },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.update).toHaveBeenCalledWith(1, { seriesName: 'Stormlight', seriesPosition: 1 });
    });

    it('accepts and persists monitorForUpgrades', async () => {
      const updated = { ...mockBook, monitorForUpgrades: true };
      (services.book.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/1',
        payload: { monitorForUpgrades: true },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.update).toHaveBeenCalledWith(1, { monitorForUpgrades: true });
      expect(JSON.parse(res.payload).monitorForUpgrades).toBe(true);
    });

    it('can toggle monitorForUpgrades from true to false', async () => {
      const updated = { ...mockBook, monitorForUpgrades: false };
      (services.book.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/1',
        payload: { monitorForUpgrades: false },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.update).toHaveBeenCalledWith(1, { monitorForUpgrades: false });
      expect(JSON.parse(res.payload).monitorForUpgrades).toBe(false);
    });

    it('rejects empty title', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/1',
        payload: { title: '  ' },
      });

      expect(res.statusCode).toBe(400);
      expect(services.book.update).not.toHaveBeenCalled();
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

  describe('POST /api/books/:id/rename', () => {
    it('returns rename result on success', async () => {
      (services.rename.renameBook as Mock).mockResolvedValue({
        oldPath: '/library/old',
        newPath: '/library/new',
        message: 'Moved from /library/old to /library/new',
        filesRenamed: 2,
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/rename' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.oldPath).toBe('/library/old');
      expect(body.newPath).toBe('/library/new');
    });

    it('returns 404 when book not found', async () => {
      (services.rename.renameBook as Mock).mockRejectedValue(
        new RenameError('Book not found', 'NOT_FOUND'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/999/rename' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when book has no path', async () => {
      (services.rename.renameBook as Mock).mockRejectedValue(
        new RenameError('Book has no path', 'NO_PATH'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/1/rename' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 409 on conflict with different book', async () => {
      (services.rename.renameBook as Mock).mockRejectedValue(
        new RenameError('Target path belongs to another book', 'CONFLICT'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/1/rename' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/books/abc/rename' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 500 on unexpected error', async () => {
      (services.rename.renameBook as Mock).mockRejectedValue(new Error('Unexpected'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/rename' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/books/:id/retag', () => {
    it('returns retag result on success', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1,
        tagged: 3,
        skipped: 0,
        failed: 0,
        warnings: [],
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tagged).toBe(3);
      expect(body.failed).toBe(0);
    });

    it('returns partial success with warnings', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1,
        tagged: 2,
        skipped: 1,
        failed: 1,
        warnings: ['ch03.ogg: Unsupported format: .ogg'],
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.tagged).toBe(2);
      expect(body.failed).toBe(1);
      expect(body.warnings).toHaveLength(1);
    });

    it('returns 400 when ffmpeg not configured', async () => {
      (services.tagging.retagBook as Mock).mockRejectedValue(
        new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg is not configured'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when book not found', async () => {
      (services.tagging.retagBook as Mock).mockRejectedValue(
        new RetagError('NOT_FOUND', 'Book 999 not found'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/999/retag' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when book has no path', async () => {
      (services.tagging.retagBook as Mock).mockRejectedValue(
        new RetagError('NO_PATH', 'Book has no library path'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 on unexpected error', async () => {
      (services.tagging.retagBook as Mock).mockRejectedValue(new Error('Unexpected'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(500);
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/books/abc/retag' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/books/missing', () => {
    it('deletes all missing books and returns count', async () => {
      (services.book.deleteByStatus as Mock).mockResolvedValue(3);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/missing' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ deleted: 3 });
      expect(services.book.deleteByStatus).toHaveBeenCalledWith('missing');
    });

    it('returns deleted: 0 when no missing books exist', async () => {
      (services.book.deleteByStatus as Mock).mockResolvedValue(0);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/missing' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ deleted: 0 });
    });

    it('returns 500 when service throws', async () => {
      (services.book.deleteByStatus as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'DELETE', url: '/api/books/missing' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
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
      (services.downloadOrchestrator.cancel as Mock).mockResolvedValue(true);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(services.downloadOrchestrator.cancel).toHaveBeenCalledWith(10);
      expect(services.downloadOrchestrator.cancel).toHaveBeenCalledWith(11);
      expect(services.downloadOrchestrator.cancel).toHaveBeenCalledTimes(2);
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });

    it('moves files to recycling bin when deleteFiles=true and book has path', async () => {
      const bookWithPath = { ...mockBook, path: '/audiobooks/Author/Book' };
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (services.recyclingBin.moveToRecycleBin as Mock).mockResolvedValue({ id: 1 });
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(200);
      expect(services.recyclingBin.moveToRecycleBin).toHaveBeenCalledWith(bookWithPath, '/audiobooks/Author/Book');
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });

    it('moves to recycling bin when deleteFiles=true but book has no path', async () => {
      const bookNoPath = { ...mockBook, path: null };
      (services.book.getById as Mock).mockResolvedValue(bookNoPath);
      (services.recyclingBin.moveToRecycleBin as Mock).mockResolvedValue({ id: 1 });
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(200);
      expect(services.recyclingBin.moveToRecycleBin).toHaveBeenCalledWith(bookNoPath, null);
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });

    it('returns 500 and preserves DB record when recycling bin move fails', async () => {
      const bookWithPath = { ...mockBook, path: '/audiobooks/Author/Book' };
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (services.recyclingBin.moveToRecycleBin as Mock).mockRejectedValue(new Error('EACCES: permission denied'));

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Failed to move book files to recycling bin');
      expect(services.download.getActiveByBookId).not.toHaveBeenCalled();
      expect(services.book.delete).not.toHaveBeenCalled();
    });

    it('does not move to recycling bin when deleteFiles param is absent', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(services.recyclingBin.moveToRecycleBin).not.toHaveBeenCalled();
    });

    it('returns 404 when deleteFiles=true and book not found', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/999?deleteFiles=true' });

      expect(res.statusCode).toBe(404);
    });

    it('delete event snapshot includes comma-joined authors and narratorName (#71)', async () => {
      const multiAuthorBook = {
        ...mockBook,
        authors: [
          createMockDbAuthor({ id: 1, name: 'Brandon Sanderson' }),
          createMockDbAuthor({ id: 2, name: 'Robert Jordan' }),
        ],
        narrators: [
          { id: 1, name: 'Michael Kramer', slug: 'michael-kramer', createdAt: new Date(), updatedAt: new Date() },
          { id: 2, name: 'Kate Reading', slug: 'kate-reading', createdAt: new Date(), updatedAt: new Date() },
        ],
      };
      (services.book.getById as Mock).mockResolvedValue(multiAuthorBook);
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(services.eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authorName: 'Brandon Sanderson, Robert Jordan',
          narratorName: 'Michael Kramer, Kate Reading',
          eventType: 'deleted',
        }),
      );
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

  // #282 — Per-book search endpoint
  describe('POST /api/books/:id/search (#282)', () => {
    const qualitySettings = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

    it('returns result: grabbed with title when best result found and grabbed', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('grabbed');
      expect(body.title).toBe('The Way of Kings');
    });

    it('returns result: no_results when search succeeds but no qualifying results', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.indexer.searchAll as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('no_results');
    });

    it('returns result: skipped with reason when book has active download', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(new Error('Book 1 already has an active download'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('skipped');
      expect(body.reason).toBe('already_has_active_download');
    });

    it('returns 404 when book ID does not exist', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'POST', url: '/api/books/999/search' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toBe('Book not found');
    });

    it('returns 500 when indexer search fails', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.indexer.searchAll as Mock).mockRejectedValue(new Error('Indexer down'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('uses quality settings for filter/rank', async () => {
      const strictQuality = { grabFloor: 100, minSeeders: 5, protocolPreference: 'torrent', rejectWords: 'abridged', requiredWords: '' };
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(strictQuality);
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings Abridged', rawTitle: 'The Way of Kings Abridged', downloadUrl: 'https://example.com/dl1', protocol: 'torrent', size: 500000, seeders: 10 },
        { title: 'The Way of Kings', rawTitle: 'The Way of Kings Full', downloadUrl: 'https://example.com/dl2', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('quality');
      // The abridged result should be filtered out by rejectWords
      if (JSON.parse(res.payload).result === 'grabbed') {
        expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
          expect.objectContaining({ downloadUrl: 'https://example.com/dl2' }),
        );
      }
    });

    it('sends grabbed result to download client via downloadService.grab', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith({
        downloadUrl: 'https://example.com/dl',
        title: 'The Way of Kings',
        protocol: 'torrent',
        bookId: mockBook.id,
        size: 500000,
        seeders: 10,
      });
    });

    it('returns 500 when downloadService.grab fails with a non-active-download error', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.indexer.searchAll as Mock).mockResolvedValue([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10 },
      ]);
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(new Error('Download client connection refused'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });
  });

  describe('error paths', () => {
    it('POST /api/books returns 500 when service.create throws', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockRejectedValue(new Error('DB insert failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Test Book', authors: [{ name: 'Author' }] },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/books/:id returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/abc' });
      expect(res.statusCode).toBe(400);
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
      (services.bookList.getAll as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('DELETE still succeeds when cancel() throws for one download', async () => {
      const activeDownloads = [
        { id: 10, bookId: 1, status: 'downloading' },
        { id: 11, bookId: 1, status: 'queued' },
      ];
      (services.download.getActiveByBookId as Mock).mockResolvedValue(activeDownloads);
      (services.downloadOrchestrator.cancel as Mock)
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

    it('GET /api/books/:id/cover returns correct MIME for png', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: '/library/book1' });
      (readdir as Mock).mockResolvedValue(['cover.png']);
      (readFile as Mock).mockResolvedValue(Buffer.from('fake-png'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('GET /api/books/:id/cover returns correct MIME for webp', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: '/library/book1' });
      (readdir as Mock).mockResolvedValue(['cover.webp']);
      (readFile as Mock).mockResolvedValue(Buffer.from('fake-webp'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
    });

    it('GET /api/books/:id/cover returns correct MIME for jpg', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: '/library/book1' });
      (readdir as Mock).mockResolvedValue(['cover.jpg']);
      (readFile as Mock).mockResolvedValue(Buffer.from('fake-jpg'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    });

    it('GET /api/books/:id returns 500 when service throws', async () => {
      (services.book.getById as Mock).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('PUT /api/books/:id returns 500 when service throws', async () => {
      (services.book.update as Mock).mockRejectedValue(new Error('DB write failed'));

      const res = await app.inject({
        method: 'PUT',
        url: '/api/books/1',
        payload: { title: 'Updated' },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('DELETE /api/books/:id returns 500 when service throws', async () => {
      (services.download.getActiveByBookId as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });
  });

  // #372 — Default pagination enforcement
  describe('GET /api/books — default pagination', () => {
    it('applies default limit=100 when no limit param provided', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 100, offset: undefined },
        { slim: true, search: undefined, sortField: undefined, sortDirection: undefined },
      );
    });

    it('applies default limit when offset provided without limit', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?offset=50' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 100, offset: 50 },
        { slim: true, search: undefined, sortField: undefined, sortDirection: undefined },
      );
    });

    it('allows explicit limit to override default', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?limit=10' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 10, offset: undefined },
        { slim: true, search: undefined, sortField: undefined, sortDirection: undefined },
      );
    });
  });

  // #372 — Server-side search/sort/filter
  describe('GET /api/books — search/sort/filter params', () => {
    it('passes search param to service', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?search=tolkien' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 100, offset: undefined },
        { slim: true, search: 'tolkien', sortField: undefined, sortDirection: undefined },
      );
    });

    it('passes sortField and sortDirection to service', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?sortField=title&sortDirection=asc' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 100, offset: undefined },
        { slim: true, search: undefined, sortField: 'title', sortDirection: 'asc' },
      );
    });

    it('rejects invalid sortField with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?sortField=invalid' });
      expect(res.statusCode).toBe(400);
    });

    it('forwards combined search, status, sort, and pagination params', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?search=foo&status=wanted&sortField=title&sortDirection=asc&limit=10&offset=0' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        'wanted',
        { limit: 10, offset: 0 },
        { slim: true, search: 'foo', sortField: 'title', sortDirection: 'asc' },
      );
    });
  });

  // #372 — Identifiers endpoint (duplicate detection)
  describe('GET /api/books/identifiers', () => {
    it('returns identifiers including authorSlug from service through HTTP boundary', async () => {
      const mockIds = [
        { asin: 'B001', title: 'Book One', authorName: 'Author A', authorSlug: 'author-a' },
        { asin: null, title: 'Book Two', authorName: null, authorSlug: null },
      ];
      (services.bookList.getIdentifiers as Mock).mockResolvedValue(mockIds);

      const res = await app.inject({ method: 'GET', url: '/api/books/identifiers' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({ asin: 'B001', title: 'Book One', authorName: 'Author A', authorSlug: 'author-a' });
      expect(body[1]).toEqual({ asin: null, title: 'Book Two', authorName: null, authorSlug: null });
    });

    it('returns 500 when service throws', async () => {
      (services.bookList.getIdentifiers as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/books/identifiers' });

      expect(res.statusCode).toBe(500);
    });
  });

  // #372 — Stats endpoint
  describe('GET /api/books/stats', () => {
    it('returns stats from service', async () => {
      const mockStats = {
        counts: { wanted: 5, downloading: 3, imported: 10, failed: 1, missing: 2 },
        authors: ['Author A'],
        series: ['Series A'],
        narrators: ['Narrator A'],
      };
      (services.bookList.getStats as Mock).mockResolvedValue(mockStats);

      const res = await app.inject({ method: 'GET', url: '/api/books/stats' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.counts.wanted).toBe(5);
      expect(body.counts.downloading).toBe(3);
      expect(body.authors).toEqual(['Author A']);
    });

    it('returns 500 when service throws', async () => {
      (services.bookList.getStats as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/books/stats' });

      expect(res.statusCode).toBe(500);
    });
  });
});

describe('POST /api/books — array payload schema (#71)', () => {
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

  it('accepts authors: [{ name, asin }] and narrators: string[] arrays', async () => {
    const bookWithNarrators = {
      ...createMockDbBook(),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    (services.book.create as Mock).mockResolvedValue(bookWithNarrators);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
        narrators: ['Michael Kramer', 'Kate Reading'],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({
      authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
      narrators: ['Michael Kramer', 'Kate Reading'],
    }));
  });

  it('rejects authors: [] with 400 (min(1))', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(services.book.create).not.toHaveBeenCalled();
  });

  it('rejects narrators: [""] with 400 (element min(1))', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: [''],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(services.book.create).not.toHaveBeenCalled();
  });

  it('accepts narrators omitted', async () => {
    const bookNoNarrators = {
      ...createMockDbBook(),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    (services.book.create as Mock).mockResolvedValue(bookNoNarrators);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        // narrators omitted
      },
    });

    expect(res.statusCode).toBe(201);
    expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'The Way of Kings',
    }));
  });
});

describe('PUT /api/books/:id — array update contract (#71)', () => {
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

  it('authors omitted → existing author junction rows unchanged', async () => {
    const existingBook = {
      ...createMockDbBook(),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.update as Mock).mockResolvedValue(existingBook);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: { title: 'Updated Title' }, // no authors field
    });

    expect(res.statusCode).toBe(200);
    // Service called without authors — junction rows left unchanged
    expect(services.book.update).toHaveBeenCalledWith(1, { title: 'Updated Title' });
  });

  it('narrators: [] → clears all narrator junction rows', async () => {
    const bookNoNarrators = {
      ...createMockDbBook(),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.update as Mock).mockResolvedValue(bookNoNarrators);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: { narrators: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(services.book.update).toHaveBeenCalledWith(1, { narrators: [] });
  });

  it('authors: [] → 400 error (min(1))', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: { authors: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(services.book.update).not.toHaveBeenCalled();
  });

  it('existing scalar fields (title, description, etc.) still update correctly', async () => {
    const updatedBook = {
      ...createMockDbBook({ title: 'New Title', description: 'New description' }),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.update as Mock).mockResolvedValue(updatedBook);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: {
        title: 'New Title',
        description: 'New description',
        authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
        narrators: ['Michael Kramer'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(services.book.update).toHaveBeenCalledWith(1, expect.objectContaining({
      title: 'New Title',
      description: 'New description',
      authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
      narrators: ['Michael Kramer'],
    }));
  });

  describe('POST /api/books/:id/merge-to-m4b', () => {
    const mergeResult = {
      bookId: 1,
      outputFile: '/library/Author/Title/Title.m4b',
      filesReplaced: 12,
      message: 'Merged 12 files into Title.m4b',
    };

    it('returns 200 with merge result on success', async () => {
      (services.merge.mergeBook as Mock).mockResolvedValue(mergeResult);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(mergeResult);
      expect(services.merge.mergeBook).toHaveBeenCalledWith(1);
    });

    it('returns 404 when book not found', async () => {
      (services.merge.mergeBook as Mock).mockRejectedValue(new MergeError('Book not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when book has no library path', async () => {
      (services.merge.mergeBook as Mock).mockRejectedValue(new MergeError('Book has no path', 'NO_PATH'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toMatchObject({ error: expect.any(String) });
    });

    it('returns 400 when book is not in imported status', async () => {
      (services.merge.mergeBook as Mock).mockRejectedValue(new MergeError('Book is not imported', 'NO_STATUS'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when no top-level audio files found at book path', async () => {
      (services.merge.mergeBook as Mock).mockRejectedValue(new MergeError('No top-level audio files', 'NO_TOP_LEVEL_FILES'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 409 when merge already in progress for this book', async () => {
      (services.merge.mergeBook as Mock).mockRejectedValue(new MergeError('Merge already in progress', 'ALREADY_IN_PROGRESS'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 503 when ffmpeg is not configured', async () => {
      (services.merge.mergeBook as Mock).mockRejectedValue(new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(503);
    });
  });
});
