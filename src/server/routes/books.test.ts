import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import type { Services } from './index.js';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';
import { MergeError } from '../services/merge.service.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { BookRejectionError } from '../services/book-rejection.service.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    createReadStream: vi.fn(),
  };
});

vi.mock('../utils/cover-cache.js', () => ({
  serveCoverFromCache: vi.fn().mockResolvedValue(null),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
  COVER_FILE_REGEX: /^cover\.(jpg|jpeg|png|webp)$/i,
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

import { serveCoverFromCache, cleanCoverCache } from '../utils/cover-cache.js';

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

  /** Mock the streaming search path used when EventBroadcaster is available. */
  function mockStreamingSearch(results: Array<Record<string, unknown>>) {
    (services.indexerSearch.getEnabledIndexers as Mock).mockResolvedValue(
      results.map((_, i) => ({ id: i + 1, name: `indexer-${i + 1}` })),
    );
    (services.indexerSearch.searchAllStreaming as Mock).mockImplementation(
      async (_q: string, _o: unknown, _c: unknown, callbacks: { onComplete: (id: number, name: string, count: number, ms: number) => void }) => {
        for (let i = 0; i < results.length; i++) {
          callbacks.onComplete(i + 1, `indexer-${i + 1}`, results.length, 100);
        }
        return results;
      },
    );
  }

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

    it('rejects ?status=archived (non-enum value) with Fastify validation envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?status=archived' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(typeof body.message).toBe('string');
      expect(body.message).toMatch(/status/);
      expect(body.message).toMatch(/wanted/);
    });

    it('rejects arbitrary ?status=foo with Fastify validation envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books?status=foo' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(typeof body.message).toBe('string');
    });

    it('returns unfiltered list when status is omitted', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [mockBook], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/books' });

      expect(res.statusCode).toBe(200);
      expect(services.bookList.getAll).toHaveBeenCalledWith(undefined, { limit: 100, offset: undefined }, { slim: true, search: undefined, sortField: undefined, sortDirection: undefined });
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
    it('creates book with title only (no authors field) and returns 201 (#246)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, authors: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun' },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Shogun',
        authors: [],
      }));
    });

    it('creates book with empty authors array and returns 201 (#246)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, authors: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun', authors: [] },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 409 when authorless duplicate exists (#246)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('returns 201 when authorless add and only authored matches exist (#253)', async () => {
      // findDuplicate returns null because authored "Shogun" is excluded by notExists
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, title: 'Shogun', authors: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun' },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.findDuplicate).toHaveBeenCalledWith('Shogun', [], undefined);
      expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Shogun', authors: [] }));
    });

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
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
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
      expect(services.indexerSearch.searchAllStreaming).toHaveBeenCalled();
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
      mockStreamingSearch([
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
      mockStreamingSearch([
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

    // ===== #386 — fire-and-forget search reads metadata.languages =====
    it('fire-and-forget search reads metadata settings for language filtering', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(DEFAULT_SETTINGS.quality);
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english', 'french'] });
        if (cat === 'search') return Promise.resolve(DEFAULT_SETTINGS.search);
        return Promise.resolve(undefined);
      });
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);

      // Wait for fire-and-forget promise to resolve
      await new Promise(r => setTimeout(r, 50));

      expect(services.settings.get).toHaveBeenCalledWith('metadata');
    });

    it('fire-and-forget search filters out results with non-matching language', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(DEFAULT_SETTINGS.quality);
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
        if (cat === 'search') return Promise.resolve(DEFAULT_SETTINGS.search);
        return Promise.resolve(undefined);
      });
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl-fr', protocol: 'torrent', size: 500000, seeders: 10, language: 'french' },
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl-en', protocol: 'torrent', size: 500000, seeders: 10, language: 'english' },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);
      await new Promise(r => setTimeout(r, 50));

      // Only the English result should be grabbed; the French one is filtered out by language
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: 'https://example.com/dl-en' }),
      );
    });

    // #406 — fire-and-forget search filters blacklisted releases via blacklistService
    it('fire-and-forget search filters blacklisted releases by infoHash', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.quality);
      (services.blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({
        blacklistedHashes: new Set(['bad-hash']),
        blacklistedGuids: new Set(),
      });
      mockStreamingSearch([
        { title: 'Blacklisted Book', downloadUrl: 'https://example.com/dl1', protocol: 'torrent', size: 500000, seeders: 100, infoHash: 'bad-hash', indexerId: 1 },
        { title: 'Clean Book', downloadUrl: 'https://example.com/dl2', protocol: 'torrent', size: 500000, seeders: 5, infoHash: 'good-hash', indexerId: 1 },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);
      await new Promise(r => setTimeout(r, 50));

      expect(services.blacklist.getBlacklistedIdentifiers).toHaveBeenCalledWith(['bad-hash', 'good-hash'], []);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Clean Book' }),
      );
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
      expect(services.indexerSearch.searchAllStreaming).not.toHaveBeenCalled();
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
      expect(services.indexerSearch.searchAllStreaming).not.toHaveBeenCalled();
    });

    it('search trigger failure does not fail book creation', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.quality);
      (services.indexerSearch.getEnabledIndexers as Mock).mockRejectedValue(new Error('Indexer down'));

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
      expect(services.indexerSearch.searchAllStreaming).not.toHaveBeenCalled();
    });

    // #439 — fire-and-forget search respects searchPriority narrator-accuracy mode
    it('fire-and-forget search grabs narrator-matched release when searchPriority is accuracy', async () => {
      const bookWithNarrators = { ...mockBook, narrators: [{ name: 'Kevin R. Free' }], duration: 36000 };
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue(bookWithNarrators);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(DEFAULT_SETTINGS.quality);
        if (cat === 'metadata') return Promise.resolve(DEFAULT_SETTINGS.metadata);
        if (cat === 'search') return Promise.resolve({ ...DEFAULT_SETTINGS.search, searchPriority: 'accuracy' });
        return Promise.resolve(undefined);
      });
      const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
      const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/quality', protocol: 'torrent', size: GOOD_SIZE, seeders: 10, narrator: 'Someone Else', matchScore: 0.9 },
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/narrator', protocol: 'torrent', size: FAIR_SIZE, seeders: 10, narrator: 'Kevin R. Free', matchScore: 0.9 },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(201);
      await new Promise(r => setTimeout(r, 50));

      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: 'https://example.com/narrator' }),
      );
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

  describe('GET /api/books/:id/rename/preview', () => {
    it('returns 200 with the plan for a valid book', async () => {
      (services.rename.planRename as Mock).mockResolvedValue({
        libraryRoot: '/library',
        folderFormat: '{author}/{title}',
        fileFormat: '{author} - {title}',
        folderMove: { from: 'Wrong/Old', to: 'Right/New' },
        fileRenames: [{ from: 'a.m4b', to: 'Brandon Sanderson - The Way of Kings.m4b' }],
      });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/rename/preview' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.folderMove).toEqual({ from: 'Wrong/Old', to: 'Right/New' });
      expect(body.fileRenames).toHaveLength(1);
    });

    it('returns 404 for unknown id', async () => {
      (services.rename.planRename as Mock).mockRejectedValue(
        new RenameError('Book not found', 'NOT_FOUND'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/999/rename/preview' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });

    it('returns 400 for NO_PATH', async () => {
      (services.rename.planRename as Mock).mockRejectedValue(
        new RenameError('Book has no path', 'NO_PATH'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/1/rename/preview' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book has no path' });
    });

    it('returns 409 with structured conflictingBook body on CONFLICT', async () => {
      (services.rename.planRename as Mock).mockRejectedValue(
        new RenameError(
          'Target path already belongs to "Other Book" (book #2)',
          'CONFLICT',
          { conflictingBook: { id: 2, title: 'Other Book' } },
        ),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/1/rename/preview' });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({
        error: 'Target path already belongs to "Other Book" (book #2)',
        code: 'CONFLICT',
        conflictingBook: { id: 2, title: 'Other Book' },
      });
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/abc/rename/preview' });
      expect(res.statusCode).toBe(400);
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
        new RenameError(
          'Target path belongs to another book',
          'CONFLICT',
          { conflictingBook: { id: 2, title: 'Other' } },
        ),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/1/rename' });

      expect(res.statusCode).toBe(409);
      // POST behavior unchanged — only `{ error }`, no structured conflictingBook
      expect(JSON.parse(res.payload)).toEqual({ error: 'Target path belongs to another book' });
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
    beforeEach(() => {
      // The DELETE route always calls bookService.getById before any branching.
      // Tests that don't exercise the deleteFiles=true path can leave the book undefined.
      (services.book.getById as Mock).mockResolvedValue(undefined);
    });

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

    it('deletes files from disk when deleteFiles=true and book has path', async () => {
      const bookWithPath = { ...mockBook, path: '/audiobooks/Author/Book' };
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (services.book.deleteBookFiles as Mock).mockResolvedValue(undefined);
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(200);
      expect(services.book.deleteBookFiles).toHaveBeenCalledWith('/audiobooks/Author/Book', '/audiobooks');
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });

    it('skips file deletion when deleteFiles=true but book has no path', async () => {
      const bookNoPath = { ...mockBook, path: null };
      (services.book.getById as Mock).mockResolvedValue(bookNoPath);
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(200);
      expect(services.book.deleteBookFiles).not.toHaveBeenCalled();
      expect(services.book.delete).toHaveBeenCalledWith(1);
    });

    it('returns 500 and preserves DB record when file deletion fails', async () => {
      const bookWithPath = { ...mockBook, path: '/audiobooks/Author/Book' };
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (services.book.deleteBookFiles as Mock).mockRejectedValue(new Error('EACCES: permission denied'));

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Failed to delete book files from disk');
      expect(services.download.getActiveByBookId).not.toHaveBeenCalled();
      expect(services.book.delete).not.toHaveBeenCalled();
    });

    it('returns 400 and preserves DB record when book path is outside library root', async () => {
      const bookWithPath = { ...mockBook, path: '/tmp/external' };
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (services.book.deleteBookFiles as Mock).mockRejectedValue(
        new PathOutsideLibraryError('/tmp/external', '/audiobooks'),
      );

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toMatch(/library root/i);
      expect(services.download.getActiveByBookId).not.toHaveBeenCalled();
      expect(services.book.delete).not.toHaveBeenCalled();
    });

    it('does not delete files when deleteFiles param is absent', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(services.book.deleteBookFiles).not.toHaveBeenCalled();
    });

    it('returns 404 when deleteFiles=true and book not found', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/999?deleteFiles=true' });

      expect(res.statusCode).toBe(404);
    });

    // #396 — cover cache cleanup on full book deletion
    it('DELETE /api/books/:id cleans up cover cache entry', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, path: '/library/book1' });
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);

      await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(cleanCoverCache).toHaveBeenCalledWith(1, '/test-config', expect.anything());
    });

    it('DELETE /api/books/:id continues when cover cache cleanup fails (best-effort)', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, path: '/library/book1' });
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(true);
      (cleanCoverCache as Mock).mockRejectedValue(new Error('EACCES'));

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      // Should still succeed — cache cleanup is best-effort
      expect(res.statusCode).toBe(200);
    });

    it('DELETE /api/books/:id does not clean cover cache when book not found', async () => {
      (cleanCoverCache as Mock).mockClear();
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 999 });
      (services.download.getActiveByBookId as Mock).mockResolvedValue([]);
      (services.book.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/books/999' });

      expect(res.statusCode).toBe(404);
      expect(cleanCoverCache).not.toHaveBeenCalled();
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

  // #320 / #1017 — Audio preview streaming endpoint (delegates to audio-preview-stream helper)
  describe('GET /api/books/:id/preview (#320, #1017)', () => {
    const bookWithPath = { ...mockBook, path: '/library/book1', status: 'imported' };
    const fileSize = 10000;
    let logWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logWarnSpy = vi.spyOn(app.log, 'warn');
    });

    function asFileEntry(name: string) {
      return { name, isFile: () => true, isDirectory: () => false };
    }

    function mockAudioDir(files: string[] = ['02-chapter.mp3', '10-chapter.mp3']) {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockResolvedValue(files.map(asFileEntry));
      (stat as Mock).mockResolvedValue({ size: fileSize, isFile: () => false, isDirectory: () => true });
      (createReadStream as Mock).mockReturnValue(Readable.from(Buffer.alloc(0)));
    }

    // Happy path
    it('returns 200 with full file body and correct Content-Type when no Range header', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(fileSize));
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 206 Partial Content with correct Content-Range and Content-Length for valid Range', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=0-1023' },
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-1023/${fileSize}`);
      expect(res.headers['content-length']).toBe('1024');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('selects alphabetically first audio file using numeric collation (02 before 10)', async () => {
      mockAudioDir(['10-chapter.mp3', '02-chapter.mp3']);

      await app.inject({ method: 'GET', url: '/api/books/1/preview' });

      // Verify the correct file was streamed (02 before 10 with numeric sort)
      expect(createReadStream).toHaveBeenCalledWith(
        expect.stringContaining('02-chapter.mp3'),
      );
    });

    it('responds with correct MIME type per extension (.wav added in #1017)', async () => {
      const cases: [string, string][] = [
        ['track.mp3', 'audio/mpeg'],
        ['track.m4b', 'audio/mp4'],
        ['track.m4a', 'audio/mp4'],
        ['track.flac', 'audio/flac'],
        ['track.ogg', 'audio/ogg'],
        ['track.opus', 'audio/ogg'],
        ['track.wma', 'audio/x-ms-wma'],
        ['track.aac', 'audio/aac'],
        ['track.wav', 'audio/wav'],
      ];

      for (const [filename, expectedMime] of cases) {
        mockAudioDir([filename]);
        const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });
        expect(res.headers['content-type']).toBe(expectedMime);
      }
    });

    // Error paths
    it('returns 404 with "Book not found" when book does not exist', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/books/999/preview' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });

    it('returns 404 with "Book not found" when book exists but path is null', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: null });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });

    it('returns 404 with "Audio file not found" when directory has no audio files', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (stat as Mock).mockResolvedValue({ size: 0, isFile: () => false, isDirectory: () => true });
      (readdir as Mock).mockResolvedValue([asFileEntry('cover.jpg'), asFileEntry('metadata.nfo')]);

      const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Audio file not found' });
    });

    it('returns 404 with "Audio file not found" when readdir throws', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (stat as Mock).mockResolvedValue({ size: 0, isFile: () => false, isDirectory: () => true });
      (readdir as Mock).mockRejectedValue(new Error('ENOENT'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Audio file not found' });
      expect(logWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, path: '/library/book1' }),
        expect.any(String),
      );
    });

    it('returns 404 with "Audio file not found" when stat throws (directory disappeared)', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (stat as Mock).mockRejectedValue(new Error('ENOENT'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Audio file not found' });
      expect(logWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, path: '/library/book1' }),
        expect.any(String),
      );
    });

    // Range edge cases
    it('returns 416 Range Not Satisfiable when start > file size', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=999999-' },
      });

      expect(res.statusCode).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${fileSize}`);
    });

    it('returns 416 Range Not Satisfiable when end < start (malformed)', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=500-200' },
      });

      expect(res.statusCode).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${fileSize}`);
    });

    it('returns 206 with correct slice for suffix range (bytes=-500)', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=-500' },
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes ${fileSize - 500}-${fileSize - 1}/${fileSize}`);
      expect(res.headers['content-length']).toBe('500');
    });

    it('returns 206 with entire content for open-ended range (bytes=0-)', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=0-' },
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-${fileSize - 1}/${fileSize}`);
      expect(res.headers['content-length']).toBe(String(fileSize));
    });

    it('returns 200 with full file for multi-range request (falls back)', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=0-100, 200-300' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-length']).toBe(String(fileSize));
    });

    it('returns 416 for malformed range syntax (non-matching)', async () => {
      mockAudioDir(['chapter.mp3']);

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/preview',
        headers: { range: 'bytes=invalid' },
      });

      expect(res.statusCode).toBe(416);
      expect(res.headers['content-range']).toBe(`bytes */${fileSize}`);
    });

    it('returns 404 for unrecognized audio extension', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (stat as Mock).mockResolvedValue({ size: 0, isFile: () => false, isDirectory: () => true });
      (readdir as Mock).mockResolvedValue([asFileEntry('track.mid')]);
      // .mid is not in AUDIO_EXTENSIONS, so preview won't find it → 404
      const res = await app.inject({ method: 'GET', url: '/api/books/1/preview' });
      expect(res.statusCode).toBe(404);
    });
  });

  // #282 — Per-book search endpoint
  describe('POST /api/books/:id/search (#282)', () => {
    const qualitySettings = { grabFloor: 0, minSeeders: 0, protocolPreference: 'none' };

    beforeEach(() => {
      // Default: grab() resolves successfully so the happy-path tests below see result='grabbed'.
      // Tests that need rejection override with mockRejectedValueOnce/mockRejectedValue.
      (services.downloadOrchestrator.grab as Mock).mockResolvedValue(undefined);
    });

    it('returns result: grabbed with title when best result found and grabbed', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
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
      mockStreamingSearch([]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('no_results');
    });

    it('returns result: skipped with reason when book has active download', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
      ]);
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(new DuplicateDownloadError('Book 1 already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));

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
      (services.indexerSearch.getEnabledIndexers as Mock).mockRejectedValue(new Error('Indexer down'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    // ===== #386 — manual search reads metadata.languages =====
    it('reads metadata settings for language filtering', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(qualitySettings);
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
        if (cat === 'search') return Promise.resolve(DEFAULT_SETTINGS.search);
        return Promise.resolve(undefined);
      });
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      expect(services.settings.get).toHaveBeenCalledWith('metadata');
    });

    it('manual search filters out results with non-matching language', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(qualitySettings);
        if (cat === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
        if (cat === 'search') return Promise.resolve(DEFAULT_SETTINGS.search);
        return Promise.resolve(undefined);
      });
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl-fr', protocol: 'torrent', size: 500000, seeders: 10, language: 'french' },
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl-en', protocol: 'torrent', size: 500000, seeders: 10, language: 'english' },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('grabbed');
      // Only the English result should be grabbed; the French one is filtered out by language
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: 'https://example.com/dl-en' }),
      );
    });

    // #439 — per-book search respects searchPriority narrator-accuracy mode
    it('per-book search grabs narrator-matched release when searchPriority is accuracy', async () => {
      const bookWithNarrators = { ...mockBook, narrators: [{ name: 'Kevin R. Free' }], duration: 36000 };
      (services.book.getById as Mock).mockResolvedValue(bookWithNarrators);
      const FAIR_SIZE = Math.round(79 * 10 * 1024 * 1024);
      const GOOD_SIZE = Math.round(200 * 10 * 1024 * 1024);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve(DEFAULT_SETTINGS.quality);
        if (cat === 'metadata') return Promise.resolve(DEFAULT_SETTINGS.metadata);
        if (cat === 'search') return Promise.resolve({ ...DEFAULT_SETTINGS.search, searchPriority: 'accuracy' });
        return Promise.resolve(undefined);
      });
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/quality', protocol: 'torrent', size: GOOD_SIZE, seeders: 10, narrator: 'Someone Else', matchScore: 0.9, indexerId: 1 },
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/narrator', protocol: 'torrent', size: FAIR_SIZE, seeders: 10, narrator: 'Kevin R. Free', matchScore: 0.9, indexerId: 1 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: 'https://example.com/narrator' }),
      );
    });

    it('uses quality settings for filter/rank', async () => {
      const strictQuality = { grabFloor: 100, minSeeders: 5, protocolPreference: 'torrent', rejectWords: 'abridged', requiredWords: '' };
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(strictQuality);
      mockStreamingSearch([
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
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({
          downloadUrl: 'https://example.com/dl',
          title: 'The Way of Kings',
          protocol: 'torrent',
          bookId: mockBook.id,
          size: 500000,
          seeders: 10,
        }),
      );
    });

    it('returns 500 when downloadService.grab fails with a non-active-download error', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      mockStreamingSearch([
        { title: 'The Way of Kings', downloadUrl: 'https://example.com/dl', protocol: 'torrent', size: 500000, seeders: 10, indexerId: 1 },
      ]);
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(new Error('Download client connection refused'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    // #406 — manual search filters blacklisted releases via blacklistService
    it('manual search filters blacklisted releases and returns no_results when all blacklisted', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({
        blacklistedHashes: new Set(['h1', 'h2']),
        blacklistedGuids: new Set(),
      });
      mockStreamingSearch([
        { title: 'Result 1', downloadUrl: 'https://example.com/dl1', protocol: 'torrent', size: 500000, seeders: 10, infoHash: 'h1', indexerId: 1 },
        { title: 'Result 2', downloadUrl: 'https://example.com/dl2', protocol: 'torrent', size: 500000, seeders: 5, infoHash: 'h2', indexerId: 1 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('no_results');
      expect(services.blacklist.getBlacklistedIdentifiers).toHaveBeenCalledWith(['h1', 'h2'], []);
      expect(services.downloadOrchestrator.grab).not.toHaveBeenCalled();
    });

    it('manual search grabs clean result when mix of blacklisted and clean', async () => {
      (services.book.getById as Mock).mockResolvedValue(mockBook);
      (services.settings.get as Mock).mockResolvedValue(qualitySettings);
      (services.blacklist.getBlacklistedIdentifiers as Mock).mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set(['bad-guid']),
      });
      mockStreamingSearch([
        { title: 'Blacklisted', downloadUrl: 'https://example.com/dl1', protocol: 'torrent', size: 500000, seeders: 100, guid: 'bad-guid', indexerId: 1 },
        { title: 'Clean', downloadUrl: 'https://example.com/dl2', protocol: 'torrent', size: 500000, seeders: 5, guid: 'good-guid', indexerId: 1 },
      ]);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/search' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe('grabbed');
      expect(services.blacklist.getBlacklistedIdentifiers).toHaveBeenCalledWith([], ['bad-guid', 'good-guid']);
      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Clean' }),
      );
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
      (services.book.getById as Mock).mockResolvedValue(undefined);
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

    it('GET /api/books/:id/cover returns 404 when book not found', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/books/999/cover' });

      expect(res.statusCode).toBe(404);
    });

    it('GET /api/books/:id/cover returns 404 when book has no path and no cache', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: null, coverUrl: null });

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

    // #396 — cover endpoint fallback to cover cache
    it('GET /api/books/:id/cover falls back to cover cache when book.path is null and cache exists', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: null, coverUrl: '/api/books/1/cover' });
      (serveCoverFromCache as Mock).mockResolvedValue({ data: Buffer.from('cached-jpg'), mime: 'image/jpeg' });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(serveCoverFromCache).toHaveBeenCalledWith(1, '/test-config');
    });

    it('GET /api/books/:id/cover returns 404 when book.path is null and no cache exists', async () => {
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: null, coverUrl: '/api/books/1/cover' });
      (serveCoverFromCache as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(404);
    });

    it('GET /api/books/:id/cover prefers book.path over cache when both exist', async () => {
      (serveCoverFromCache as Mock).mockClear();
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, path: '/library/book1', coverUrl: '/api/books/1/cover' });
      (readdir as Mock).mockResolvedValue(['cover.jpg']);
      (readFile as Mock).mockResolvedValue(Buffer.from('disk-jpg'));

      const res = await app.inject({ method: 'GET', url: '/api/books/1/cover' });

      expect(res.statusCode).toBe(200);
      expect(serveCoverFromCache).not.toHaveBeenCalled();
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

  it('accepts authors: [] (empty array) with 201 (#246)', async () => {
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    (services.book.create as Mock).mockResolvedValue(mockBook);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'The Way of Kings',
      authors: [],
    }));
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
    it('returns 202 with { status: started, bookId } when slot available', async () => {
      (services.merge.enqueueMerge as Mock).mockResolvedValue({ status: 'started', bookId: 1 });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.payload)).toEqual({ status: 'started', bookId: 1 });
      expect(services.merge.enqueueMerge).toHaveBeenCalledWith(1);
    });

    it('returns 202 with { status: queued, bookId, position } when no slot', async () => {
      (services.merge.enqueueMerge as Mock).mockResolvedValue({ status: 'queued', bookId: 1, position: 2 });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.payload)).toEqual({ status: 'queued', bookId: 1, position: 2 });
    });

    it('returns 404 when book not found', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('Book not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when book has no library path', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('Book has no path', 'NO_PATH'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toMatchObject({ error: expect.any(String) });
    });

    it('returns 400 when book is not in imported status', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('Book is not imported', 'NO_STATUS'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when no top-level audio files found at book path', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('No top-level audio files', 'NO_TOP_LEVEL_FILES'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 409 when merge already in progress for this book', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('Merge already in progress', 'ALREADY_IN_PROGRESS'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 409 when merge already queued for this book', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('Merge already queued for this book', 'ALREADY_QUEUED'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 503 when ffmpeg is not configured', async () => {
      (services.merge.enqueueMerge as Mock).mockRejectedValue(new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/merge-to-m4b' });

      expect(res.statusCode).toBe(503);
    });
  });

  describe('POST /api/books/:id/wrong-release', () => {
    it('returns 200 and calls bookRejectionService for imported book with identifiers', async () => {
      (services.bookRejection.rejectAsWrongRelease as Mock).mockResolvedValue(undefined);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/wrong-release' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(services.bookRejection.rejectAsWrongRelease).toHaveBeenCalledWith(1);
    });

    it('returns 400 when book status is not imported', async () => {
      (services.bookRejection.rejectAsWrongRelease as Mock).mockRejectedValue(new BookRejectionError('Book is not imported', 'NOT_IMPORTED'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/wrong-release' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book is not imported' });
    });

    it('returns 400 when book has no lastGrabGuid or lastGrabInfoHash', async () => {
      (services.bookRejection.rejectAsWrongRelease as Mock).mockRejectedValue(new BookRejectionError('Book has no release identifiers', 'NO_IDENTIFIERS'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/wrong-release' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book has no release identifiers' });
    });

    it('returns 404 when book does not exist', async () => {
      (services.bookRejection.rejectAsWrongRelease as Mock).mockRejectedValue(new BookRejectionError('Book not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/books/1/wrong-release' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
    });
  });

  // #341 — book_added event on POST /api/books
  describe('book_added event on create', () => {
    it('records book_added event with source=manual after successful create', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      const createdBook = { ...mockBook, id: 42, title: 'Test Book' };
      (services.book.create as Mock).mockResolvedValue(createdBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Test Book', authors: [{ name: 'Author One' }] },
      });

      expect(res.statusCode).toBe(201);
      expect(services.eventHistory.create).toHaveBeenCalledWith({
        bookId: 42,
        bookTitle: 'Test Book',
        authorName: createdBook.authors.map(a => a.name).join(', '),
        narratorName: null,
        eventType: 'book_added',
        source: 'manual',
      });
    });

    it('includes comma-joined authorName for multi-author books', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      const multiAuthorBook = {
        ...mockBook,
        id: 43,
        title: 'Multi Author Book',
        authors: [
          { id: 1, name: 'Author A', slug: 'author-a', createdAt: new Date(), updatedAt: new Date() },
          { id: 2, name: 'Author B', slug: 'author-b', createdAt: new Date(), updatedAt: new Date() },
        ],
      };
      (services.book.create as Mock).mockResolvedValue(multiAuthorBook);

      await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Multi Author Book', authors: [{ name: 'Author A' }, { name: 'Author B' }] },
      });

      expect(services.eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authorName: 'Author A, Author B',
          eventType: 'book_added',
        }),
      );
    });

    it('does NOT record book_added event when 409 duplicate is returned', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Duplicate Book', authors: [{ name: 'Author' }] },
      });

      expect(res.statusCode).toBe(409);
      expect(services.eventHistory.create).not.toHaveBeenCalled();
    });

    it('book creation succeeds even if eventHistory.create() rejects (fire-and-forget)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue(null);
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, id: 44 });
      (services.eventHistory.create as Mock).mockRejectedValue(new Error('DB write failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Test Book' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('DELETE /api/books/:id/merge-to-m4b (cancel merge)', () => {
    it('returns 200 with { success: true } when merge is cancellable', async () => {
      (services.merge.cancelMerge as Mock).mockResolvedValue({ status: 'cancelled' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/books/1/merge-to-m4b',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(services.merge.cancelMerge).toHaveBeenCalledWith(1);
    });

    it('returns 404 when no merge is active for bookId', async () => {
      (services.merge.cancelMerge as Mock).mockResolvedValue({ status: 'not-found' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/books/1/merge-to-m4b',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'No active merge for this book' });
    });

    it('returns 409 when merge is in committing phase', async () => {
      (services.merge.cancelMerge as Mock).mockResolvedValue({ status: 'committing' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/books/1/merge-to-m4b',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Merge is past the point of no return' });
    });

    it('returns 400 for invalid bookId param', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/books/abc/merge-to-m4b',
      });

      expect(res.statusCode).toBe(400);
    });
  });

});

// #445 — POST /api/books/:id/cover
// Separate top-level describe because createTestApp does NOT register @fastify/multipart.
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import multipart from '@fastify/multipart';
import { registerRoutes } from './index.js';
import type { Db } from '../../db/index.js';
import { inject } from '../__tests__/helpers.js';
import { CoverUploadError } from '../services/book.service.js';

/** Build a raw multipart/form-data payload for Fastify inject. */
function createCoverPayload(filename: string, content: Buffer, mimetype: string, boundary = 'boundary123') {
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimetype}\r\n` +
    `\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, content, footer]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('POST /api/books/:id/cover', () => {
  let app: Awaited<ReturnType<typeof Fastify>>;
  let services: Services;

  const updatedBook = {
    ...mockBook,
    path: '/library/book',
    coverUrl: '/api/books/1/cover',
    updatedAt: new Date('2024-06-01T00:00:00Z'),
  };

  beforeAll(async () => {
    services = createMockServices();
    const mockDb = inject<Db>({ run: vi.fn().mockResolvedValue(undefined) });

    const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
    await instance.register(errorHandlerPlugin);
    await instance.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
    await registerRoutes(instance, services, mockDb);
    await instance.ready();
    app = instance;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('happy path', () => {
    it('uploads valid JPEG and returns 200 with updated book', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue(updatedBook);
      const imageData = Buffer.from('fake-jpeg-data');
      const { payload, contentType } = createCoverPayload('cover.jpg', imageData, 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.coverUrl).toBe('/api/books/1/cover');
      expect(services.book.uploadCover).toHaveBeenCalledWith(1, expect.any(Buffer), 'image/jpeg');
    });

    it('uploads valid PNG and passes image/png mimetype to service', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue(updatedBook);
      const imageData = Buffer.from('fake-png-data');
      const { payload, contentType } = createCoverPayload('cover.png', imageData, 'image/png');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.uploadCover).toHaveBeenCalledWith(1, expect.any(Buffer), 'image/png');
    });

    it('uploads valid WebP and passes image/webp mimetype to service', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue(updatedBook);
      const imageData = Buffer.from('fake-webp-data');
      const { payload, contentType } = createCoverPayload('cover.webp', imageData, 'image/webp');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.uploadCover).toHaveBeenCalledWith(1, expect.any(Buffer), 'image/webp');
    });
  });

  describe('MIME type validation', () => {
    it('rejects application/pdf with 400', async () => {
      (services.book.uploadCover as Mock).mockRejectedValue(
        new CoverUploadError('Only JPG, PNG, and WebP images are supported', 'INVALID_MIME'),
      );
      const { payload, contentType } = createCoverPayload('file.pdf', Buffer.from('pdf-data'), 'application/pdf');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('Only JPG, PNG, and WebP');
    });

    it('rejects image/gif with 400', async () => {
      (services.book.uploadCover as Mock).mockRejectedValue(
        new CoverUploadError('Only JPG, PNG, and WebP images are supported', 'INVALID_MIME'),
      );
      const { payload, contentType } = createCoverPayload('image.gif', Buffer.from('gif-data'), 'image/gif');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('size validation', () => {
    it('accepts file at exactly 10 MB boundary', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue(updatedBook);
      const exactlyTenMb = Buffer.alloc(10 * 1024 * 1024);
      const { payload, contentType } = createCoverPayload('exact.jpg', exactlyTenMb, 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.uploadCover).toHaveBeenCalledWith(1, expect.any(Buffer), 'image/jpeg');
    });

    it('rejects file over 10 MB with 400', async () => {
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
      const { payload, contentType } = createCoverPayload('big.jpg', oversized, 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('10 MB');
      // Service should NOT have been called
      expect(services.book.uploadCover).not.toHaveBeenCalled();
    });
  });

  describe('error paths', () => {
    it('returns 404 for non-existent book', async () => {
      (services.book.uploadCover as Mock).mockRejectedValue(
        new CoverUploadError('Book not found', 'NOT_FOUND'),
      );
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('data'), 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/999/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for book with no path', async () => {
      (services.book.uploadCover as Mock).mockRejectedValue(
        new CoverUploadError('Book has no path on disk', 'NO_PATH'),
      );
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('data'), 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when no file is attached', async () => {
      const boundary = 'boundary456';
      const emptyPayload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nempty\r\n--${boundary}--\r\n`
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload: emptyPayload,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('No file uploaded');
    });

    it('returns 500 on unexpected service error', async () => {
      (services.book.uploadCover as Mock).mockRejectedValue(new Error('EACCES: permission denied'));
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('data'), 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });

    it('returns 400 for invalid bookId param', async () => {
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('data'), 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/abc/cover',
        payload,
        headers: { 'content-type': contentType },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});

describe('#514 books route — missing blacklistService guard', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    (services as unknown as Record<string, unknown>).blacklist = undefined;
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not trigger search when blacklistService is absent even with searchImmediately', async () => {
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    (services.book.create as Mock).mockResolvedValueOnce({ ...mockBook, status: 'wanted' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
    });

    expect(res.statusCode).toBe(201);

    // Wait for any fire-and-forget promise to settle
    await new Promise(r => setTimeout(r, 50));

    // If the guard were absent, triggerImmediateSearch would call searchAllStreaming
    expect(services.indexerSearch.searchAllStreaming).not.toHaveBeenCalled();
  });
});

describe('#1071 series routes', () => {
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

  it('GET /api/books/:id/series returns { series: null } when no cache/local data', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: null });
    (services.seriesRefresh.getSeriesForBook as Mock).mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/api/books/1/series' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ series: null });
  });

  it('GET /api/books/:id/series surfaces the new authorName/publishedDate/duration member fields (#1079)', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: 'B01NA0JA51', seriesName: 'The Band' });
    (services.seriesRefresh.getSeriesForBook as Mock).mockResolvedValue({
      id: 1,
      name: 'The Band',
      providerSeriesId: 'B07DHQY7DX',
      lastFetchedAt: '2026-05-11T00:00:00.000Z',
      lastFetchStatus: 'success',
      nextFetchAfter: null,
      members: [
        {
          id: 1,
          providerBookId: 'A1',
          title: 'Kings of the Wyld',
          positionRaw: '1',
          position: 1,
          isCurrent: true,
          libraryBookId: 1,
          coverUrl: null,
          authorName: 'Nicholas Eames',
          publishedDate: '2017-02-21',
          duration: 1300,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/books/1/series' });

    expect(res.statusCode).toBe(200);
    const member = res.json().series.members[0];
    expect(member.authorName).toBe('Nicholas Eames');
    expect(member.publishedDate).toBe('2017-02-21');
    expect(member.duration).toBe(1300);
  });

  it('GET /api/books/:id/series returns 404 for missing book', async () => {
    (services.book.getById as Mock).mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/api/books/999/series' });

    expect(res.statusCode).toBe(404);
  });

  it('POST /api/books/:id/series/refresh returns the documented envelope on success', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: 'B01NA0JA51' });
    (services.seriesRefresh.reconcileFromBookAsin as Mock).mockResolvedValue({
      status: 'refreshed',
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        lastFetchStatus: 'success',
        nextFetchAfter: null,
        members: [],
      },
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('refreshed');
    expect(res.json().series.name).toBe('The Band');
    expect(services.seriesRefresh.reconcileFromBookAsin).toHaveBeenCalledWith(
      'B01NA0JA51',
      expect.objectContaining({ manual: true, bookId: 1 }),
    );
  });

  it('POST /api/books/:id/series/refresh returns 400 when book has no ASIN', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: null });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/refresh' });

    expect(res.statusCode).toBe(400);
  });

  it('POST /api/books/:id/series/refresh forwards rate_limited envelope verbatim', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: 'B01NA0JA51' });
    (services.seriesRefresh.reconcileFromBookAsin as Mock).mockResolvedValue({
      status: 'rate_limited',
      series: null,
      nextFetchAfter: '2026-05-11T01:00:00.000Z',
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'rate_limited', series: null, nextFetchAfter: '2026-05-11T01:00:00.000Z' });
  });

  it('POST /api/books enqueues async series refresh when the created book has ASIN + seriesName (F7)', async () => {
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    const created = { ...mockBook, id: 42, asin: 'B01NA0JA51', seriesName: 'The Band', seriesPosition: 1, status: 'wanted' };
    (services.book.create as Mock).mockResolvedValueOnce(created);
    const enqueueRefresh = vi.fn();
    (services.seriesRefresh.enqueueRefresh as Mock).mockImplementation(enqueueRefresh);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Kings of the Wyld',
        authors: [{ name: 'Nicholas Eames' }],
        asin: 'B01NA0JA51',
        seriesName: 'The Band',
        seriesPosition: 1,
        seriesAsin: 'B07DHQY7DX',
        seriesProvider: 'audible',
      },
    });

    expect(res.statusCode).toBe(201);
    // Wait for fire-and-forget enqueue to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(enqueueRefresh).toHaveBeenCalledTimes(1);
    expect(enqueueRefresh).toHaveBeenCalledWith('B01NA0JA51', expect.objectContaining({
      bookId: 42,
      seriesName: 'The Band',
      providerSeriesId: 'B07DHQY7DX',
    }));
  });

  it('POST /api/books does NOT enqueue refresh when the created book lacks an ASIN (F7 guard)', async () => {
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    const created = { ...mockBook, id: 42, asin: null, seriesName: 'The Band', status: 'wanted' };
    (services.book.create as Mock).mockResolvedValueOnce(created);
    const enqueueRefresh = vi.fn();
    (services.seriesRefresh.enqueueRefresh as Mock).mockImplementation(enqueueRefresh);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Title',
        authors: [{ name: 'Author' }],
        seriesName: 'The Band',
      },
    });

    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    expect(enqueueRefresh).not.toHaveBeenCalled();
  });

  it('POST /api/books does NOT enqueue refresh when the created book has no series (F7 guard)', async () => {
    (services.book.findDuplicate as Mock).mockResolvedValue(null);
    const created = { ...mockBook, id: 42, asin: 'B01NA0JA51', seriesName: null, status: 'wanted' };
    (services.book.create as Mock).mockResolvedValueOnce(created);
    const enqueueRefresh = vi.fn();
    (services.seriesRefresh.enqueueRefresh as Mock).mockImplementation(enqueueRefresh);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Standalone',
        authors: [{ name: 'Author' }],
        asin: 'B01NA0JA51',
      },
    });

    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    expect(enqueueRefresh).not.toHaveBeenCalled();
  });
});
