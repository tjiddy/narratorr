import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { booksRoutes, type BookRouteDeps } from './books.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import { DEFAULT_LIMITS } from '../../shared/schemas.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import type { Services } from './index.js';
import { RenameError } from '../services/rename.service.js';
import { OwnedRecordingError } from '../services/book-dedup.js';
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

// #1670 — spy on the OPF writer (the per-book refresh helper calls it cross-module). The route
// tests assert it is/isn't called with the right `enabled` + `bookFolder`, not OPF XML generation.
vi.mock('../utils/opf-writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/opf-writer.js')>()),
  writeOpfSidecar: vi.fn().mockResolvedValue('written'),
}));

import { serveCoverFromCache } from '../utils/cover-cache.js';
import { writeOpfSidecar } from '../utils/opf-writer.js';
import { createMockSettingsService } from '../__tests__/helpers.js';
import type { BookService } from '../services/book.service.js';

const mockBook = {
  ...createMockDbBook(),
  authors: [createMockDbAuthor()],
  narrators: [],
};

/**
 * Build a complete `BookRouteDeps` with all 17 services mocked. Each call
 * derives fresh `vi.fn()`-backed mocks from `createMockServices()`, so a test
 * mutating the returned deps can't leak into a later call. Pass `overrides` to
 * replace any field; omitted fields keep their default mock.
 *
 * Overrides is `Partial<BookRouteDeps>` rather than a bare-undefined-stripping
 * shape: callers add or replace fields but never need to strip a default, so it
 * compiles cleanly under `exactOptionalPropertyTypes` without explicit-`undefined`
 * literals (see `fixture-builder-eopt-overrides`).
 */
function makeBookRouteDeps(overrides: Partial<BookRouteDeps> = {}): BookRouteDeps {
  const s = createMockServices();
  return {
    bookService: s.book,
    bookListService: s.bookList,
    downloadService: s.download,
    downloadOrchestrator: s.downloadOrchestrator,
    settingsService: s.settings,
    renameService: s.rename,
    mergeService: s.merge,
    taggingService: s.tagging,
    eventHistory: s.eventHistory,
    bookDeletionService: s.bookDeletion,
    indexerSearchService: s.indexerSearch,
    indexerService: s.indexer,
    bookRejectionService: s.bookRejection,
    blacklistService: s.blacklist,
    eventBroadcaster: s.eventBroadcaster,
    seriesCardService: s.seriesCard,
    metadataService: s.metadata,
    connectorService: makeMockConnector(),
    ...overrides,
  };
}

/** Minimal ConnectorService stand-in — only `notifyRefresh` is exercised by the refresh triggers. */
function makeMockConnector(): NonNullable<BookRouteDeps['connectorService']> {
  return { notifyRefresh: vi.fn().mockResolvedValue(undefined) } as unknown as NonNullable<BookRouteDeps['connectorService']>;
}

/** Register only `booksRoutes` onto a fresh Fastify app, wired from the given
 *  `BookRouteDeps`. Mirrors `createTestApp` but takes route deps directly so a
 *  test can exercise the routes through a factory-built deps object. */
async function createAppFromDeps(deps: BookRouteDeps) {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);
  await booksRoutes(app, deps);
  await app.ready();
  return app;
}

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

      expect(services.bookList.getAll).toHaveBeenCalledWith('wanted', { limit: DEFAULT_LIMITS.books, offset: undefined }, { slim: true });
    });

    it('forwards limit and offset to service', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?limit=10&offset=20' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(undefined, { limit: 10, offset: 20 }, { slim: true });
    });

    it('forwards author/series/narrator filters to service (#1143)', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?author=Sanderson&series=Stormlight&narrator=Kramer' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        { slim: true, author: 'Sanderson', series: 'Stormlight', narrator: 'Kramer' },
      );
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
      expect(services.bookList.getAll).toHaveBeenCalledWith(undefined, { limit: DEFAULT_LIMITS.books, offset: undefined }, { slim: true });
    });
  });

  describe('GET /api/library/books (#1132)', () => {
    const libraryRow = {
      id: 1, title: 'The Way of Kings', coverUrl: null, status: 'wanted' as const,
      seriesName: null, seriesPosition: null,
      authors: [{ name: 'Brandon Sanderson' }], narrators: [],
      audioTotalSize: null, size: null, audioFileFormat: null,
      audioDuration: null, duration: null, path: null, audioFileCount: null,
      lastGrabGuid: null, lastGrabInfoHash: null,
      createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01'),
    };

    it('returns slim DTO in { data, total } envelope', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [libraryRow], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/library/books' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: 1, title: 'The Way of Kings', status: 'wanted',
        authors: [{ name: 'Brandon Sanderson' }], narrators: [],
      });
    });

    it('routes status/search/sort/limit/offset params through to the service', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books?status=wanted&search=king&sortField=title&sortDirection=asc&limit=10&offset=20' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(
        'wanted',
        { limit: 10, offset: 20 },
        { search: 'king', sortField: 'title', sortDirection: 'asc' },
      );
    });

    it('forwards author/series/narrator filters to service (#1143)', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books?author=Sanderson&series=Stormlight&narrator=Kramer' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        { author: 'Sanderson', series: 'Stormlight', narrator: 'Kramer' },
      );
    });

    it(`defaults to limit=${DEFAULT_LIMITS.books} when omitted`, async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(undefined, { limit: DEFAULT_LIMITS.books, offset: undefined }, {});
    });

    it('rejects ?status=monitored (invalid enum) with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/library/books?status=monitored' });
      expect(res.statusCode).toBe(400);
    });

    // #1447 (S2d) — the library filter param is bucket-only: `all` is a
    // client-only sentinel (the client omits the param), and non-bucket canonical
    // statuses like `searching`/`importing` are not valid filter buckets.
    it('rejects ?status=all (client-only sentinel) with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/library/books?status=all' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects ?status=searching (non-bucket canonical status) with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/library/books?status=searching' });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a bucket key like ?status=downloading and forwards it to the service', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      const res = await app.inject({ method: 'GET', url: '/api/library/books?status=downloading' });

      expect(res.statusCode).toBe(200);
      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(
        'downloading',
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        {},
      );
    });

    it('rejects limit=0 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/library/books?limit=0' });
      expect(res.statusCode).toBe(400);
    });

    it('forwards collapse=true to service as boolean true (#1169)', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books?collapse=true' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        { collapse: true },
      );
    });

    it('forwards collapse=false to service as boolean false (#1169)', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books?collapse=false' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        { collapse: false },
      );
    });

    it('omits collapse from service options when param is absent (#1169)', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        {},
      );
    });

    it('rejects ?collapse=maybe with 400 (#1169)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/library/books?collapse=maybe' });
      expect(res.statusCode).toBe(400);
    });

    it('does not invoke BookListService.getAll (the full-shape endpoint stays untouched)', async () => {
      (services.bookList.getAllForLibrary as Mock).mockResolvedValue({ data: [], total: 0 });
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/library/books' });

      expect(services.bookList.getAllForLibrary).toHaveBeenCalledTimes(1);
      expect(services.bookList.getAll).not.toHaveBeenCalled();
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, authors: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun', authors: [] },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 409 when authorless duplicate exists (#246)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'same-recording', book: mockBook });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('returns 201 when authorless add and only authored matches exist (#253)', async () => {
      // findDuplicate returns null because authored "Shogun" is excluded by notExists
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
      (services.book.create as Mock).mockResolvedValue({ ...mockBook, title: 'Shogun', authors: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Shogun' },
      });

      expect(res.statusCode).toBe(201);
      expect(services.book.findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Shogun', authors: [] }));
      expect(services.book.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Shogun', authors: [] }));
    });

    it('creates book and returns 201', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'same-recording', book: mockBook });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).title).toBe('The Way of Kings');
      expect(services.book.create).not.toHaveBeenCalled();
    });

    // #1723 F8 — a create-time ASIN race: findDuplicate clears the pre-create guard
    // (different-recording) but create() fail-closes with OwnedRecordingError. The
    // route must 409 with the incumbent owner (fetched via getById) and fire NONE of
    // the post-create side effects, even with searchImmediately:true requested.
    it('returns 409 with the incumbent owner on a create-time ASIN race and fires no post-create side effects (#1723 F8)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
      (services.book.create as Mock).mockRejectedValue(
        new OwnedRecordingError({ existingBookId: 7, title: 'The Way of Kings', reason: 'asin-owned' }),
      );
      (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 7 });
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.quality);

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], searchImmediately: true },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).id).toBe(7);
      expect(services.book.getById).toHaveBeenCalledWith(7);

      // Give any (incorrectly) fired fire-and-forget work a tick to surface.
      await new Promise(r => setTimeout(r, 50));
      expect(services.eventHistory.create).not.toHaveBeenCalled();
      expect(services.indexerSearch.searchAllStreaming).not.toHaveBeenCalled();
      expect(services.downloadOrchestrator.grab).not.toHaveBeenCalled();
    });

    // #1723 F8 — a `review` verdict (uncertain recording identity) carrying an
    // incumbent must block with 409 surfacing that incumbent, never create.
    it('returns 409 with the incumbent on a review verdict, without creating (#1723 F8)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'review', book: { ...mockBook, id: 88 } });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).id).toBe(88);
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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

    it('passes providerId to service for ASIN enrichment', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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

  // #1670 — per-book OPF refresh on metadata-change triggers (PUT). The writer is spied; we assert
  // the `enabled` gate (from tagging.writeOpf) and the `bookFolder` (the book's path) it is called with.
  describe('PUT /api/books/:id — OPF sidecar refresh (#1670)', () => {
    const writeOpfMock = vi.mocked(writeOpfSidecar);

    beforeEach(() => { writeOpfMock.mockClear(); });

    function depsFor(opts: { writeOpf: boolean; path: string | null }) {
      const bookService = inject<BookService>({
        update: vi.fn().mockResolvedValue({ ...mockBook, id: 1, path: opts.path }),
        getById: vi.fn().mockResolvedValue({ ...mockBook, id: 1, path: opts.path }),
      });
      return makeBookRouteDeps({
        bookService,
        settingsService: createMockSettingsService({ tagging: { writeOpf: opts.writeOpf } }),
      });
    }

    it('refreshes the OPF after update on an imported book with writeOpf=true', async () => {
      const app2 = await createAppFromDeps(depsFor({ writeOpf: true, path: '/lib/Author/Book' }));
      const res = await app2.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } });
      expect(res.statusCode).toBe(200);
      expect(writeOpfMock).toHaveBeenCalledTimes(1);
      expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bookId: 1, bookFolder: '/lib/Author/Book' }));
      await app2.close();
    });

    it('passes enabled=false (short-circuit) when writeOpf is off', async () => {
      const app2 = await createAppFromDeps(depsFor({ writeOpf: false, path: '/lib/Author/Book' }));
      const res = await app2.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } });
      expect(res.statusCode).toBe(200);
      expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
      await app2.close();
    });

    it('skips the writer entirely for a not-imported book (path=null)', async () => {
      const app2 = await createAppFromDeps(depsFor({ writeOpf: true, path: null }));
      const res = await app2.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } });
      expect(res.statusCode).toBe(200);
      expect(writeOpfMock).not.toHaveBeenCalled();
      await app2.close();
    });

    it('still returns 200 when the OPF refresh throws (nonfatal)', async () => {
      writeOpfMock.mockRejectedValueOnce(new Error('boom'));
      const app2 = await createAppFromDeps(depsFor({ writeOpf: true, path: '/lib/Author/Book' }));
      const res = await app2.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } });
      expect(res.statusCode).toBe(200);
      await app2.close();
    });

    it('skips the write for a single-file pointer path (no crash)', async () => {
      // The writer (real impl) guards the pointer path; here we assert it is invoked with that
      // bookFolder and the route still succeeds — the spy stands in for the real skip.
      const app2 = await createAppFromDeps(depsFor({ writeOpf: true, path: '/audiobooks/Doctor Sleep.m4b' }));
      const res = await app2.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } });
      expect(res.statusCode).toBe(200);
      expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ bookFolder: '/audiobooks/Doctor Sleep.m4b' }));
      await app2.close();
    });

    // #1707 — the standalone edit route fires a 'metadata' refresh only when the OPF was written.
    it("fires a 'metadata' refresh when the OPF is written, none when skipped", async () => {
      const notifyRefresh = vi.fn().mockResolvedValue(undefined);
      const connectorService = inject<NonNullable<BookRouteDeps['connectorService']>>({ notifyRefresh });

      writeOpfMock.mockResolvedValueOnce('written');
      const app2 = await createAppFromDeps({ ...depsFor({ writeOpf: true, path: '/lib/Author/Book' }), connectorService });
      expect((await app2.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } })).statusCode).toBe(200);
      expect(notifyRefresh).toHaveBeenCalledTimes(1);
      expect(notifyRefresh).toHaveBeenCalledWith('metadata', [expect.objectContaining({ bookId: 1, libraryPath: '/lib/Author/Book' })]);
      await app2.close();

      writeOpfMock.mockResolvedValueOnce('skipped');
      notifyRefresh.mockClear();
      const app3 = await createAppFromDeps({ ...depsFor({ writeOpf: false, path: '/lib/Author/Book' }), connectorService });
      expect((await app3.inject({ method: 'PUT', url: '/api/books/1', payload: { title: 'X' } })).statusCode).toBe(200);
      expect(notifyRefresh).not.toHaveBeenCalled();
      await app3.close();
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

    it('maps path_outside_library → 400 with the real ancestry-guard message (#1550)', async () => {
      // Use the real PathOutsideLibraryError message (not a fabricated string) so this
      // pins the actual `error: error.message` pass-through. The global handler emits
      // message-only — there is no PATH_OUTSIDE_LIBRARY literal in the response body.
      const err = new PathOutsideLibraryError('/etc/passwd', '/audiobooks');
      (services.rename.renameBook as Mock).mockRejectedValue(err);

      const res = await app.inject({ method: 'POST', url: '/api/books/1/rename' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: err.message });
      expect(JSON.parse(res.payload)).not.toHaveProperty('code');
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

  describe('GET /api/books/:id/retag/preview', () => {
    it('returns 200 with the plan for a valid book', async () => {
      (services.tagging.planRetag as Mock).mockResolvedValue({
        mode: 'overwrite',
        embedCover: false,
        hasCoverFile: false,
        isSingleFile: true,
        canonical: { artist: 'A', albumArtist: 'A', album: 'B', title: 'B' },
        files: [
          { file: 'book.mp3', outcome: 'will-tag', diff: [{ field: 'artist', current: null, next: 'A' }], coverPending: false },
        ],
        warnings: [],
      });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/retag/preview' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.canonical.artist).toBe('A');
      expect(body.files).toHaveLength(1);
      expect(body.files[0].outcome).toBe('will-tag');
    });

    it('returns 404 for unknown id', async () => {
      (services.tagging.planRetag as Mock).mockRejectedValue(
        new RetagError('NOT_FOUND', 'Book 999 not found'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/999/retag/preview' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for NO_PATH', async () => {
      (services.tagging.planRetag as Mock).mockRejectedValue(
        new RetagError('NO_PATH', 'Book has no library path'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/1/retag/preview' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for PATH_MISSING', async () => {
      (services.tagging.planRetag as Mock).mockRejectedValue(
        new RetagError('PATH_MISSING', 'Book path does not exist on disk'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/1/retag/preview' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 503 for FFMPEG_NOT_CONFIGURED (aligns with MergeError)', async () => {
      (services.tagging.planRetag as Mock).mockRejectedValue(
        new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg is not configured'),
      );

      const res = await app.inject({ method: 'GET', url: '/api/books/1/retag/preview' });

      expect(res.statusCode).toBe(503);
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/books/abc/retag/preview' });
      expect(res.statusCode).toBe(400);
    });

    it('forwards mode + embedCover query params to planRetag as overrides', async () => {
      (services.tagging.planRetag as Mock).mockResolvedValue({
        mode: 'overwrite', embedCover: true, hasCoverFile: false, isSingleFile: true,
        canonical: { album: 'B', title: 'B' }, files: [], warnings: [],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/retag/preview?mode=overwrite&embedCover=true',
      });

      expect(res.statusCode).toBe(200);
      expect(services.tagging.planRetag).toHaveBeenCalledWith(1, { mode: 'overwrite', embedCover: true });
    });

    it('omits overrides when neither query param is present (settings defaults)', async () => {
      (services.tagging.planRetag as Mock).mockResolvedValue({
        mode: 'populate_missing', embedCover: false, hasCoverFile: false, isSingleFile: true,
        canonical: { album: 'B', title: 'B' }, files: [], warnings: [],
      });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/retag/preview' });

      expect(res.statusCode).toBe(200);
      expect(services.tagging.planRetag).toHaveBeenCalledWith(1, {});
    });

    it('returns 400 when ?mode=garbage', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/retag/preview?mode=garbage',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when ?embedCover=maybe (must be true/false)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/books/1/retag/preview?embedCover=maybe',
      });
      expect(res.statusCode).toBe(400);
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

    // #1721 — `refreshItem` is server-only internal enqueue state (carries the absolute on-disk
    // libraryPath). It must NOT serialize into the public retag response, so the happy-path API shape
    // is unchanged and the filesystem path never leaks to the client.
    it('does not expose the internal refreshItem (or its libraryPath) in the response', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 2, skipped: 0, failed: 0, warnings: [],
        refreshItem: { bookId: 1, title: 'Book', authorName: 'A', libraryPath: '/abs/library/Author/Book' },
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).not.toHaveProperty('refreshItem');
      expect(res.payload).not.toContain('/abs/library/Author/Book');
      // Public shape is exactly counts + warnings.
      expect(Object.keys(body).sort()).toEqual(['bookId', 'failed', 'skipped', 'tagged', 'warnings']);
    });

    // #1707 — the per-book retag route fires a 'metadata' refresh only when ≥1 file was tagged.
    // #1721 — the refresh item now comes from RetagResult.refreshItem (built pre-tag-write), so the
    // route no longer reloads the book after the mutation; getById rejecting can't drop the refresh.
    it("fires a 'metadata' refresh when ≥1 file tagged, none when all skipped", async () => {
      const notify = services.connector.notifyRefresh as Mock;
      notify.mockResolvedValue(undefined);
      // A post-retag reload would fail — proves the refresh no longer depends on it.
      (services.book.getById as Mock).mockRejectedValue(new Error('libSQL read failed'));

      (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 1, tagged: 2, skipped: 0, failed: 0, warnings: [], refreshItem: { bookId: 1, title: 'Book', authorName: 'A', libraryPath: '/lib/A/Book' } });
      notify.mockClear();
      expect((await app.inject({ method: 'POST', url: '/api/books/1/retag' })).statusCode).toBe(200);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith('metadata', [expect.objectContaining({ bookId: 1, libraryPath: '/lib/A/Book' })]);

      (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 1, tagged: 0, skipped: 4, failed: 0, warnings: [], refreshItem: { bookId: 1, title: 'Book', authorName: 'A', libraryPath: '/lib/A/Book' } });
      notify.mockClear();
      expect((await app.inject({ method: 'POST', url: '/api/books/1/retag' })).statusCode).toBe(200);
      expect(notify).not.toHaveBeenCalled();
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

    it('returns 503 when ffmpeg not configured (aligns with MergeError)', async () => {
      (services.tagging.retagBook as Mock).mockRejectedValue(
        new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg is not configured'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(503);
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

    it('forwards empty excludeFields as empty set to service', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/retag',
        payload: { excludeFields: [] },
      });

      expect(res.statusCode).toBe(200);
      const callArgs = (services.tagging.retagBook as Mock).mock.calls.at(-1)!;
      expect(callArgs[0]).toBe(1);
      const passedSet = callArgs[1] as Set<string>;
      expect(Array.from(passedSet)).toEqual([]);
    });

    it('forwards excludeFields to service', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/retag',
        payload: { excludeFields: ['title', 'track'] },
      });

      expect(res.statusCode).toBe(200);
      const callArgs = (services.tagging.retagBook as Mock).mock.calls.at(-1)!;
      const passedSet = callArgs[1] as Set<string>;
      expect(Array.from(passedSet).sort()).toEqual(['title', 'track']);
    });

    it('rejects unknown excludeFields values with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/retag',
        payload: { excludeFields: ['foo'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('omitting body still calls retagBook with empty excludeFields', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [],
      });

      const res = await app.inject({ method: 'POST', url: '/api/books/1/retag' });

      expect(res.statusCode).toBe(200);
      const callArgs = (services.tagging.retagBook as Mock).mock.calls.at(-1)!;
      const passedSet = callArgs[1] as Set<string>;
      expect(passedSet.size).toBe(0);
      // Third arg (overrides) defaults to empty object when no body fields present
      expect(callArgs[2]).toEqual({});
    });

    it('forwards mode + embedCover body to retagBook as overrides', async () => {
      (services.tagging.retagBook as Mock).mockResolvedValue({
        bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/retag',
        payload: { mode: 'overwrite', embedCover: false },
      });

      expect(res.statusCode).toBe(200);
      const callArgs = (services.tagging.retagBook as Mock).mock.calls.at(-1)!;
      expect(callArgs[2]).toEqual({ mode: 'overwrite', embedCover: false });
    });

    it('rejects unknown mode in body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/retag',
        payload: { mode: 'garbage' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects extra body fields with 400 (strict schema)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books/1/retag',
        payload: { embedCover: true, somethingExtra: 1 },
      });
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

  // The route is a thin result-to-status mapper over BookDeletionService; the
  // destructive workflow itself (ordering, per-step error policy, best-effort
  // failures) is covered in book-deletion.service.test.ts.
  describe('DELETE /api/books/:id', () => {
    it('maps deleted → 200 with success body', async () => {
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({ outcome: 'deleted', bookTitle: 'The Way of Kings' });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
      expect(services.bookDeletion.deleteBook).toHaveBeenCalledWith(1, { deleteFiles: false });
    });

    it('passes deleteFiles=true through to the service', async () => {
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({ outcome: 'deleted', bookTitle: 'The Way of Kings' });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(200);
      expect(services.bookDeletion.deleteBook).toHaveBeenCalledWith(1, { deleteFiles: true });
    });

    it('maps not_found → 404', async () => {
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({ outcome: 'not_found' });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/999' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toBe('Book not found');
    });

    it('maps path_outside_library → 400 with the real ancestry-guard message', async () => {
      // Use the real PathOutsideLibraryError message (not a fabricated string) so
      // this pins the actual `error: error.message` pass-through end-to-end.
      const realMessage = new PathOutsideLibraryError('/etc/passwd', '/audiobooks').message;
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({
        outcome: 'path_outside_library',
        error: realMessage,
      });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toMatch(/not inside library root/);
    });

    it('maps file_deletion_failed → 500 with the service-provided message', async () => {
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({
        outcome: 'file_deletion_failed',
        error: 'Failed to delete book files from disk',
      });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Failed to delete book files from disk');
    });

    it('serializes the kept-files fileSummary on the deleted body (#1589)', async () => {
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({
        outcome: 'deleted',
        bookTitle: 'The Way of Kings',
        fileSummary: { deletedManaged: 2, preservedForeign: ['book.epub', 'notes.pdf'] },
      });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1?deleteFiles=true' });

      expect(res.statusCode).toBe(200);
      // The route must carry the kept-files disclosure through to the client (AC).
      expect(JSON.parse(res.payload)).toEqual({
        success: true,
        fileSummary: { deletedManaged: 2, preservedForeign: ['book.epub', 'notes.pdf'] },
      });
    });

    it('omits fileSummary from the deleted body when the service did not return one', async () => {
      (services.bookDeletion.deleteBook as Mock).mockResolvedValue({ outcome: 'deleted', bookTitle: 'The Way of Kings' });

      const res = await app.inject({ method: 'DELETE', url: '/api/books/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
    });
  });

  describe('GET /api/books/:id/files', () => {
    const bookWithPath = { ...mockBook, path: '/library/book1', status: 'imported' };

    // `collectAudioFilePaths` calls `readdir(dir, { withFileTypes: true })`,
    // so the mock must return Dirent-shaped entries. These helpers keep each
    // test's intent legible without repeating the `isFile`/`isDirectory` shape.
    const asFile = (name: string) => ({ name, isFile: () => true, isDirectory: () => false });
    const asDir = (name: string) => ({ name, isFile: () => false, isDirectory: () => true });

    it('returns audio files with sizes, filtering non-audio files', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockResolvedValue(
        ['Chapter 01.m4b', 'Chapter 02.m4b', 'cover.jpg', 'metadata.nfo'].map(asFile),
      );
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
      (readdir as Mock).mockResolvedValue(
        ['Chapter 10.m4b', 'Chapter 2.m4b', 'Chapter 1.m4b'].map(asFile),
      );
      (stat as Mock).mockResolvedValue({ size: 1000 });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });

      const body = JSON.parse(res.payload);
      expect(body.map((f: { name: string }) => f.name)).toEqual([
        'Chapter 1.m4b',
        'Chapter 2.m4b',
        'Chapter 10.m4b',
      ]);
    });

    // Surfaced 2026-05-15: a Finders Keepers rip with 100 mp3s spread across
    // 10 disc subfolders reported "FILES (0)" because the route used a flat
    // readdir against the book root. Switching to `collectAudioFilePaths`
    // with `recursive: true` makes nested disc folders enumerate correctly,
    // and the relative-path display lets multi-disc names disambiguate.
    it('recurses into subdirectories (multi-disc layout) and returns POSIX relative paths', async () => {
      (services.book.getById as Mock).mockResolvedValue(bookWithPath);
      (readdir as Mock).mockImplementation((dir: string) => {
        if (dir === '/library/book1') return Promise.resolve([asDir('Disc 01'), asDir('Disc 02')]);
        if (dir.endsWith('Disc 01')) return Promise.resolve([asFile('Track 01.mp3'), asFile('Track 02.mp3')]);
        if (dir.endsWith('Disc 02')) return Promise.resolve([asFile('Track 01.mp3')]);
        return Promise.resolve([]);
      });
      (stat as Mock).mockResolvedValue({ size: 1000 });

      const res = await app.inject({ method: 'GET', url: '/api/books/1/files' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { name: string; size: number }[];
      expect(body.map(f => f.name)).toEqual([
        'Disc 01/Track 01.mp3',
        'Disc 01/Track 02.mp3',
        'Disc 02/Track 01.mp3',
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
      (readdir as Mock).mockResolvedValue(['cover.jpg', 'metadata.nfo'].map(asFile));

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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
    it(`applies default limit=${DEFAULT_LIMITS.books} when no limit param provided`, async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        { slim: true, search: undefined, sortField: undefined, sortDirection: undefined },
      );
    });

    it('applies default limit when offset provided without limit', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?offset=50' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: 50 },
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
        { limit: DEFAULT_LIMITS.books, offset: undefined },
        { slim: true, search: 'tolkien', sortField: undefined, sortDirection: undefined },
      );
    });

    it('passes sortField and sortDirection to service', async () => {
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/books?sortField=title&sortDirection=asc' });

      expect(services.bookList.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: DEFAULT_LIMITS.books, offset: undefined },
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
    (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
    (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
    (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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

  it('accepts the extended metadata body (publishedDate/genres/nullable description+coverUrl) and delegates to the service (#1609)', async () => {
    const updatedBook = {
      ...createMockDbBook(),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.update as Mock).mockResolvedValue(updatedBook);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: {
        description: null,
        coverUrl: null,
        publishedDate: '2010-08-31',
        genres: ['Fantasy', 'Epic'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(services.book.update).toHaveBeenCalledWith(1, {
      description: null,
      coverUrl: null,
      publishedDate: '2010-08-31',
      genres: ['Fantasy', 'Epic'],
    });
  });

  it('passes null clears for publishedDate and genres through to the service (#1609)', async () => {
    const updatedBook = {
      ...createMockDbBook(),
      authors: [createMockDbAuthor()],
      narrators: [],
    };
    (services.book.update as Mock).mockResolvedValue(updatedBook);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: { publishedDate: null, genres: null },
    });

    expect(res.statusCode).toBe(200);
    expect(services.book.update).toHaveBeenCalledWith(1, { publishedDate: null, genres: null });
  });

  it('rejects an invalid publishedDate type (number) with 400 (#1609)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: { publishedDate: 123 },
    });

    expect(res.statusCode).toBe(400);
    expect(services.book.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid genres type (string) with 400 (#1609)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/books/1',
      payload: { genres: 'Fantasy' },
    });

    expect(res.statusCode).toBe(400);
    expect(services.book.update).not.toHaveBeenCalled();
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'same-recording', book: mockBook });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books',
        payload: { title: 'Duplicate Book', authors: [{ name: 'Author' }] },
      });

      expect(res.statusCode).toBe(409);
      expect(services.eventHistory.create).not.toHaveBeenCalled();
    });

    it('book creation succeeds even if eventHistory.create() rejects (fire-and-forget)', async () => {
      (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
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
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
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
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
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
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
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

  // #1670 — a cover upload on an imported book refreshes the OPF sidecar (F3: bookFilesRoute now
  // takes settingsService). A failing OPF refresh must not fail the upload response.
  describe('OPF sidecar refresh (#1670)', () => {
    const writeOpfMock = vi.mocked(writeOpfSidecar);

    it('refreshes the OPF after a successful upload when writeOpf=true', async () => {
      writeOpfMock.mockClear();
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(cat === 'tagging' ? { writeOpf: true } : {}));
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('x'), 'image/jpeg');

      const res = await app.inject({ method: 'POST', url: '/api/books/1/cover', payload, headers: { 'content-type': contentType } });

      expect(res.statusCode).toBe(200);
      expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bookId: 1, bookFolder: '/library/book' }));
    });

    it('still returns 200 when the OPF refresh throws (nonfatal)', async () => {
      writeOpfMock.mockClear();
      writeOpfMock.mockRejectedValueOnce(new Error('boom'));
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(cat === 'tagging' ? { writeOpf: true } : {}));
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('x'), 'image/jpeg');

      const res = await app.inject({ method: 'POST', url: '/api/books/1/cover', payload, headers: { 'content-type': contentType } });

      expect(res.statusCode).toBe(200);
    });
  });

  // #1707 — the cover-upload route is the single aggregation point for its two media-visible writes
  // (cover.* + metadata.opf): EXACTLY ONE 'metadata' refresh per upload when either materialized.
  describe('connector refresh aggregation (#1707)', () => {
    const writeOpfMock = vi.mocked(writeOpfSidecar);
    function primeTagging(writeOpf: boolean) {
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(cat === 'tagging' ? { writeOpf } : {}));
    }
    function notify() { return services.connector.notifyRefresh as Mock; }

    async function upload() {
      const { payload, contentType } = createCoverPayload('cover.jpg', Buffer.from('x'), 'image/jpeg');
      return app.inject({ method: 'POST', url: '/api/books/1/cover', payload, headers: { 'content-type': contentType } });
    }

    beforeEach(() => {
      writeOpfMock.mockClear();
      notify().mockResolvedValue(undefined);
      notify().mockClear();
    });

    it('fires EXACTLY ONE refresh when both the cover and the OPF wrote (no double-fire)', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
      writeOpfMock.mockResolvedValueOnce('written');
      primeTagging(true);

      expect((await upload()).statusCode).toBe(200);
      expect(notify()).toHaveBeenCalledTimes(1);
      expect(notify()).toHaveBeenCalledWith('metadata', [expect.objectContaining({ bookId: 1 })]);
    });

    it('fires once off the cover write even with writeOpf off (OPF skipped)', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
      writeOpfMock.mockResolvedValueOnce('skipped');
      primeTagging(false);

      expect((await upload()).statusCode).toBe(200);
      expect(notify()).toHaveBeenCalledTimes(1);
    });

    it("fires when the cover DB update threw after the rename (coverOutcome stays 'written')", async () => {
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
      writeOpfMock.mockResolvedValueOnce('skipped');
      primeTagging(false);

      expect((await upload()).statusCode).toBe(200);
      expect(notify()).toHaveBeenCalledTimes(1);
    });

    it('fires NO refresh when both sub-writes skipped/failed', async () => {
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'failed' });
      writeOpfMock.mockResolvedValueOnce('skipped');
      primeTagging(false);

      expect((await upload()).statusCode).toBe(200);
      expect(notify()).not.toHaveBeenCalled();
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
      (services.book.uploadCover as Mock).mockResolvedValue({ book: updatedBook, coverOutcome: 'written' });
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

// #1558 — `BookRouteDeps` now marks all 17 services required, so the old
// `#514` "absent blacklistService" test (which forced `services.blacklist =
// undefined` and asserted search is NOT triggered) is no longer representable.
// The positive required-deps path — search IS triggered for a `searchImmediately`
// create on a `wanted` book — is covered by 'triggers search when
// searchImmediately is true and status is wanted' in the POST /api/books block.
describe('#1558 makeBookRouteDeps factory', () => {
  const ALL_FIELDS: Array<keyof BookRouteDeps> = [
    'bookService', 'bookListService', 'downloadService', 'downloadOrchestrator',
    'settingsService', 'renameService', 'mergeService', 'taggingService',
    'eventHistory', 'bookDeletionService', 'indexerSearchService', 'indexerService',
    'bookRejectionService', 'blacklistService', 'eventBroadcaster', 'seriesCardService',
    'metadataService',
  ];

  it('returns a complete BookRouteDeps with all 17 fields defined', () => {
    const deps = makeBookRouteDeps();
    expect(ALL_FIELDS).toHaveLength(17);
    for (const field of ALL_FIELDS) {
      expect(deps[field], `expected ${field} to be defined`).toBeDefined();
    }
  });

  it('replaces only the overridden field, leaving the other 16 as defaults', () => {
    const customBookService = inject<BookRouteDeps['bookService']>({
      getById: vi.fn().mockResolvedValue(mockBook),
    });
    const deps = makeBookRouteDeps({ bookService: customBookService });

    expect(deps.bookService).toBe(customBookService);
    for (const field of ALL_FIELDS) {
      if (field === 'bookService') continue;
      expect(deps[field], `expected default ${field} to be present`).toBeDefined();
    }
  });

  it('returns independent objects across calls — a mutation does not leak', () => {
    const first = makeBookRouteDeps();
    const second = makeBookRouteDeps();

    // Distinct mock instances per call (fresh createMockServices each time).
    expect(first.bookService).not.toBe(second.bookService);

    // Mutating one returned deps must not affect a later-built deps.
    const sentinel = inject<BookRouteDeps['metadataService']>({ lookupForFixMatch: vi.fn() });
    first.metadataService = sentinel;
    expect(second.metadataService).not.toBe(sentinel);
  });

  it('routes wired from factory deps are reachable (GET /api/books/:id)', async () => {
    const deps = makeBookRouteDeps({
      bookService: inject<BookRouteDeps['bookService']>({
        getById: vi.fn().mockResolvedValue({ ...mockBook, id: 7 }),
      }),
    });
    const app = await createAppFromDeps(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/books/7' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 7 });
    } finally {
      await app.close();
    }
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
    (services.seriesCard.getSeriesForBook as Mock).mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/api/books/1/series' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ series: null });
  });

  it('GET /api/books/:id/series surfaces the canonical response shape (#1133)', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: 'B01NA0JA51', seriesName: 'The Band' });
    (services.seriesCard.getSeriesForBook as Mock).mockResolvedValue({
      id: 1,
      name: 'The Band',
      hardcoverSeriesId: 5523,
      seriesAuthor: 'Nicholas Eames',
      lastFetchedAt: '2026-05-11T00:00:00.000Z',
      members: [
        {
          hardcoverBookId: 7711,
          slug: 'kings-of-the-wyld',
          title: 'Kings of the Wyld',
          position: 1,
          imageUrl: null,
          inLibrary: true,
          libraryBookId: 1,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/books/1/series' });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.series.hardcoverSeriesId).toBe(5523);
    expect(json.series.seriesAuthor).toBe('Nicholas Eames');
    const member = json.series.members[0];
    expect(member.hardcoverBookId).toBe(7711);
    expect(member.inLibrary).toBe(true);
    expect(member.libraryBookId).toBe(1);
  });

  it('GET /api/books/:id/series returns 404 for missing book', async () => {
    (services.book.getById as Mock).mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/api/books/999/series' });

    expect(res.statusCode).toBe(404);
  });

  it('POST /api/books/:id/series/refresh returns { series } on success', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: 'B01NA0JA51' });
    (services.seriesCard.refreshSeriesForBook as Mock).mockResolvedValue({
      id: 1,
      name: 'The Band',
      hardcoverSeriesId: 5523,
      seriesAuthor: 'Nicholas Eames',
      lastFetchedAt: '2026-05-11T00:00:00.000Z',
      members: [],
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json().series.name).toBe('The Band');
    expect(services.seriesCard.refreshSeriesForBook).toHaveBeenCalledWith(1);
  });

  it('POST /api/books/:id/series/refresh returns 200 even when book has no ASIN (#1133 — gate removed)', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: null, seriesName: 'The Band' });
    (services.seriesCard.refreshSeriesForBook as Mock).mockResolvedValue({
      id: null,
      name: 'The Band',
      hardcoverSeriesId: null,
      seriesAuthor: null,
      lastFetchedAt: null,
      members: [],
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json().series.name).toBe('The Band');
  });

  it('POST /api/books/:id/series/refresh returns { series: null } when the book has no series', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, asin: 'B01NA0JA51', seriesName: null });
    (services.seriesCard.refreshSeriesForBook as Mock).mockResolvedValue(null);

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ series: null });
  });

  // #1228: manual Hardcover series search + bind routes.
  it('GET /api/books/:id/series/search returns candidates and forwards the query', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: 'The Band' });
    (services.seriesCard.searchSeriesCandidates as Mock).mockResolvedValue([
      { id: 5523, name: 'The Band', slug: 'the-band', authorName: 'Nicholas Eames', booksCount: 3, readersCount: 0, imageUrl: null },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/books/1/series/search?q=the%20band' });

    expect(res.statusCode).toBe(200);
    expect(res.json().candidates[0].id).toBe(5523);
    expect(services.seriesCard.searchSeriesCandidates).toHaveBeenCalledWith('the band');
  });

  it('GET /api/books/:id/series/search returns an empty list (not a 500) when Hardcover yields nothing', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: 'The Band' });
    (services.seriesCard.searchSeriesCandidates as Mock).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/books/1/series/search?q=nothing' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ candidates: [] });
  });

  it('GET /api/books/:id/series/search returns 404 for a missing book', async () => {
    (services.book.getById as Mock).mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/books/999/series/search?q=x' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/books/:id/series/search rejects an empty query', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: 'The Band' });
    const res = await app.inject({ method: 'GET', url: '/api/books/1/series/search?q=' });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/books/:id/series/bind returns the rebuilt card and forwards the id', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: 'The Earthsea Cycle' });
    (services.seriesCard.bindHardcoverSeries as Mock).mockResolvedValue({
      id: 9, name: 'The Earthsea Quartet', hardcoverSeriesId: 4242, seriesAuthor: 'Ursula K. Le Guin', lastFetchedAt: null, members: [],
    });

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/bind', payload: { hardcoverSeriesId: 4242 } });

    expect(res.statusCode).toBe(200);
    expect(res.json().series.hardcoverSeriesId).toBe(4242);
    expect(services.seriesCard.bindHardcoverSeries).toHaveBeenCalledWith(1, 4242);
  });

  it('POST /api/books/:id/series/bind returns 502 when binding fails', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: 'The Band' });
    (services.seriesCard.bindHardcoverSeries as Mock).mockResolvedValue(null);

    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/bind', payload: { hardcoverSeriesId: 4242 } });

    expect(res.statusCode).toBe(502);
  });

  it('POST /api/books/:id/series/bind returns 404 for a missing book', async () => {
    (services.book.getById as Mock).mockResolvedValue(null);
    const res = await app.inject({ method: 'POST', url: '/api/books/999/series/bind', payload: { hardcoverSeriesId: 4242 } });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/books/:id/series/bind rejects a non-positive hardcoverSeriesId', async () => {
    (services.book.getById as Mock).mockResolvedValue({ ...mockBook, id: 1, seriesName: 'The Band' });
    const res = await app.inject({ method: 'POST', url: '/api/books/1/series/bind', payload: { hardcoverSeriesId: 0 } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/books no longer enqueues an async series refresh (#1133 — lazy via GET)', async () => {
    (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
    const created = { ...mockBook, id: 42, asin: 'B01NA0JA51', seriesName: 'The Band', seriesPosition: 1, status: 'wanted' };
    (services.book.create as Mock).mockResolvedValueOnce(created);
    const refresh = vi.fn();
    (services.seriesCard.refreshSeriesForBook as Mock).mockImplementation(refresh);

    const res = await app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Kings of the Wyld',
        authors: [{ name: 'Nicholas Eames' }],
        asin: 'B01NA0JA51',
        seriesName: 'The Band',
        seriesPosition: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    expect(refresh).not.toHaveBeenCalled();
  });

  describe('POST /api/books/:id/fix-match (#1129)', () => {
    const sourceBook = {
      ...mockBook,
      id: 7,
      asin: 'B_OLD',
      title: 'Old Title',
      seriesName: 'Old Series',
      seriesPosition: 1,
    };
    const newMetaSeriesBearing = {
      asin: 'B_NEW',
      title: 'New Title',
      authors: [{ name: 'New Author' }],
      narrators: ['New Narrator'],
      description: 'New description',
      coverUrl: 'https://example.com/new.jpg',
      duration: 1200,
      publishedDate: '2024-05-01',
      seriesPrimary: { name: 'New Series', position: 2, asin: 'SERIES_NEW' },
      series: [{ name: 'New Series', position: 2, asin: 'SERIES_NEW' }],
      genres: ['Fantasy'],
      isbn: '9781111111111',
    };
    const newMetaStandalone = {
      asin: 'B_STANDALONE',
      title: 'Standalone Title',
      authors: [{ name: 'Solo Author' }],
      narrators: ['Solo Narrator'],
      description: 'desc',
      coverUrl: 'https://example.com/solo.jpg',
      duration: 500,
      publishedDate: '2024-05-02',
    };

    it('series-bearing fix match: returns 200, updates row, emits event', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
      (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'ok', book: newMetaSeriesBearing });
      const updated = { ...sourceBook, asin: 'B_NEW', title: 'New Title', seriesName: 'New Series', seriesPosition: 2 };
      (services.book.fixMatch as Mock).mockResolvedValueOnce(updated);
      (services.eventHistory.create as Mock).mockResolvedValueOnce({ id: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/7/fix-match',
        payload: { asin: 'B_NEW' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.book.fixMatch).toHaveBeenCalledWith(7, expect.objectContaining({
        asin: 'B_NEW',
        title: 'New Title',
        seriesName: 'New Series',
        seriesPosition: 2,
        seriesAsin: 'SERIES_NEW',
        genres: ['Fantasy'],
        isbn: '9781111111111',
      }));
      await new Promise((r) => setTimeout(r, 10));
      expect(services.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 7,
        eventType: 'metadata_fixed',
        reason: expect.objectContaining({ oldAsin: 'B_OLD', newAsin: 'B_NEW', oldTitle: 'Old Title', newTitle: 'New Title' }),
      }));
    });

    it('no-series fix match: returns 200, still emits event (F15)', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
      (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'ok', book: newMetaStandalone });
      const updated = { ...sourceBook, asin: 'B_STANDALONE', title: 'Standalone Title', seriesName: null, seriesPosition: null };
      (services.book.fixMatch as Mock).mockResolvedValueOnce(updated);
      (services.eventHistory.create as Mock).mockResolvedValueOnce({ id: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/7/fix-match',
        payload: { asin: 'B_STANDALONE' },
      });

      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(services.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'metadata_fixed',
      }));
    });

    it('ASIN collision: returns 409 with conflictBookId/conflictTitle, does NOT call fixMatch', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce({ conflictBookId: 99, conflictTitle: 'Other Book' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/books/7/fix-match',
        payload: { asin: 'B_DUP' },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toMatchObject({ conflictBookId: 99, conflictTitle: 'Other Book' });
      expect(services.book.fixMatch).not.toHaveBeenCalled();
      expect(services.metadata.lookupForFixMatch).not.toHaveBeenCalled();
    });

    it('lookup not_found → 404 with "ASIN not resolved"', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
      (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'not_found' });

      const res = await app.inject({ method: 'POST', url: '/api/books/7/fix-match', payload: { asin: 'B_404' } });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toBe('ASIN not resolved');
      expect(services.book.fixMatch).not.toHaveBeenCalled();
    });

    it('lookup rate_limited → 503 with retryAfterMs', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
      (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'rate_limited', retryAfterMs: 60_000 });

      const res = await app.inject({ method: 'POST', url: '/api/books/7/fix-match', payload: { asin: 'B_429' } });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.payload);
      expect(body.retryAfterMs).toBe(60_000);
    });

    it('lookup invalid_record → 422 (covers both mapped and raw)', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
      (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'invalid_record' });

      const res = await app.inject({ method: 'POST', url: '/api/books/7/fix-match', payload: { asin: 'B_INV' } });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.payload).error).toBe('Incomplete provider record');
    });

    it('lookup transient_failure → 502 "Provider lookup failed"', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(sourceBook);
      (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
      (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'transient_failure', message: 'HTTP 503' });

      const res = await app.inject({ method: 'POST', url: '/api/books/7/fix-match', payload: { asin: 'B_5xx' } });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.payload).error).toBe('Provider lookup failed');
    });

    it('book not found → 404 before any lookup', async () => {
      (services.book.getById as Mock).mockResolvedValueOnce(null);

      const res = await app.inject({ method: 'POST', url: '/api/books/9999/fix-match', payload: { asin: 'B_X' } });
      expect(res.statusCode).toBe(404);
      expect(services.metadata.lookupForFixMatch).not.toHaveBeenCalled();
    });

    it('strict schema: rejects unknown top-level keys', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/books/7/fix-match',
        payload: { asin: 'B_X', provider: 'audible' },
      });
      expect(res.statusCode).toBe(400);
    });

    describe('post-commit rename/retag follow-up (F3)', () => {
      const sourceBookWithPath = { ...sourceBook, path: '/library/book-7' };
      const updatedWithPath = {
        ...sourceBookWithPath,
        asin: 'B_NEW',
        title: 'New Title',
      };

      function primeSuccessfulFixMatch() {
        (services.book.getById as Mock).mockResolvedValueOnce(sourceBookWithPath);
        (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
        (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'ok', book: newMetaSeriesBearing });
        (services.book.fixMatch as Mock).mockResolvedValueOnce(updatedWithPath);
        (services.eventHistory.create as Mock).mockResolvedValueOnce({ id: 1 });
      }

      it('renameFiles=true: invokes renameService.renameBook(bookId) after metadata commit', async () => {
        primeSuccessfulFixMatch();
        (services.rename.renameBook as Mock).mockResolvedValueOnce({ oldPath: '/a', newPath: '/b', message: 'ok', filesRenamed: 1 });

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', renameFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.rename.renameBook).toHaveBeenCalledTimes(1);
        expect(services.rename.renameBook).toHaveBeenCalledWith(7);
        expect(services.tagging.retagBook).not.toHaveBeenCalled();
      });

      it('retagFiles=true: invokes taggingService.retagBook(bookId, Set, {}) after metadata commit', async () => {
        primeSuccessfulFixMatch();
        (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 7, tagged: 1, skipped: 0, failed: 0, warnings: [] });

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.tagging.retagBook).toHaveBeenCalledTimes(1);
        const [bookIdArg, excludeFieldsArg, overridesArg] = (services.tagging.retagBook as Mock).mock.calls[0]!;
        expect(bookIdArg).toBe(7);
        expect(excludeFieldsArg).toBeInstanceOf(Set);
        expect((excludeFieldsArg as Set<string>).size).toBe(0);
        expect(overridesArg).toEqual({});
        expect(services.rename.renameBook).not.toHaveBeenCalled();
      });

      it('both flags: invokes both rename and retag, returns 200', async () => {
        primeSuccessfulFixMatch();
        (services.rename.renameBook as Mock).mockResolvedValueOnce({ oldPath: '/a', newPath: '/b', message: 'ok', filesRenamed: 1 });
        (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 7, tagged: 1, skipped: 0, failed: 0, warnings: [] });

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', renameFiles: true, retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.rename.renameBook).toHaveBeenCalledWith(7);
        expect(services.tagging.retagBook).toHaveBeenCalledWith(7, expect.any(Set), {});
      });

      it('flags omitted: neither rename nor retag is called', async () => {
        primeSuccessfulFixMatch();

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW' },
        });

        expect(res.statusCode).toBe(200);
        expect(services.rename.renameBook).not.toHaveBeenCalled();
        expect(services.tagging.retagBook).not.toHaveBeenCalled();
      });

      // #1670 — Fix Match refreshes the OPF on BOTH the retag and non-retag paths, gated on
      // tagging.writeOpf, independent of retagFiles. Configure settings so the writer is reached.
      function primeWriteOpfEnabled() {
        (services.settings.get as Mock).mockImplementation((cat: string) =>
          Promise.resolve(cat === 'tagging' ? { writeOpf: true } : {}));
      }

      it('retagFiles=false: still refreshes the OPF (non-retag path is the regression target)', async () => {
        const writeOpfMock = vi.mocked(writeOpfSidecar);
        writeOpfMock.mockClear();
        primeSuccessfulFixMatch();
        primeWriteOpfEnabled();

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', retagFiles: false },
        });

        expect(res.statusCode).toBe(200);
        expect(services.tagging.retagBook).not.toHaveBeenCalled();
        expect(writeOpfMock).toHaveBeenCalledTimes(1);
        expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bookId: 7, bookFolder: '/library/book-7' }));
      });

      it('retagFiles=true: refreshes the OPF exactly once (no double write with the retag)', async () => {
        const writeOpfMock = vi.mocked(writeOpfSidecar);
        writeOpfMock.mockClear();
        primeSuccessfulFixMatch();
        primeWriteOpfEnabled();
        (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 7, tagged: 1, skipped: 0, failed: 0, warnings: [] });

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.tagging.retagBook).toHaveBeenCalledTimes(1);
        expect(writeOpfMock).toHaveBeenCalledTimes(1);
      });

      // #1707 — Fix Match emits EXACTLY ONE 'metadata' refresh covering its retag + OPF writes.
      it('retagFiles=true: fires exactly one metadata connector refresh (not one per writer)', async () => {
        vi.mocked(writeOpfSidecar).mockClear();
        primeSuccessfulFixMatch();
        primeWriteOpfEnabled();
        (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 7, tagged: 1, skipped: 0, failed: 0, warnings: [] });
        const notify = services.connector.notifyRefresh as Mock;
        notify.mockResolvedValue(undefined);
        notify.mockClear();

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('metadata', [expect.objectContaining({ bookId: 7 })]);
      });

      it("retagFiles=false with writeOpf off: fires NO metadata refresh (nothing materialized)", async () => {
        vi.mocked(writeOpfSidecar).mockClear();
        vi.mocked(writeOpfSidecar).mockResolvedValueOnce('skipped');
        primeSuccessfulFixMatch();
        const notify = services.connector.notifyRefresh as Mock;
        notify.mockResolvedValue(undefined);
        notify.mockClear();

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', retagFiles: false },
        });

        expect(res.statusCode).toBe(200);
        expect(notify).not.toHaveBeenCalled();
      });

      it('renameFiles=true on book without path: skips renameService call', async () => {
        const noPathBook = { ...sourceBook, path: null };
        const updatedNoPath = { ...noPathBook, asin: 'B_NEW', title: 'New Title' };
        (services.book.getById as Mock).mockResolvedValueOnce(noPathBook);
        (services.book.findAsinCollision as Mock).mockResolvedValueOnce(null);
        (services.metadata.lookupForFixMatch as Mock).mockResolvedValueOnce({ kind: 'ok', book: newMetaSeriesBearing });
        (services.book.fixMatch as Mock).mockResolvedValueOnce(updatedNoPath);
        (services.eventHistory.create as Mock).mockResolvedValueOnce({ id: 1 });

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', renameFiles: true, retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.rename.renameBook).not.toHaveBeenCalled();
        expect(services.tagging.retagBook).not.toHaveBeenCalled();
      });

      it('rename failure is isolated: response still 200, no exception propagates', async () => {
        primeSuccessfulFixMatch();
        (services.rename.renameBook as Mock).mockRejectedValueOnce(new Error('Disk full'));

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', renameFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.rename.renameBook).toHaveBeenCalledWith(7);
      });

      it('retag failure is isolated: response still 200, no exception propagates', async () => {
        primeSuccessfulFixMatch();
        (services.tagging.retagBook as Mock).mockRejectedValueOnce(new Error('ffmpeg missing'));

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.tagging.retagBook).toHaveBeenCalledWith(7, expect.any(Set), {});
      });

      it('rename failure does NOT skip the retag step (failures are independent)', async () => {
        primeSuccessfulFixMatch();
        (services.rename.renameBook as Mock).mockRejectedValueOnce(new Error('rename boom'));
        (services.tagging.retagBook as Mock).mockResolvedValueOnce({ bookId: 7, tagged: 1, skipped: 0, failed: 0, warnings: [] });

        const res = await app.inject({
          method: 'POST',
          url: '/api/books/7/fix-match',
          payload: { asin: 'B_NEW', renameFiles: true, retagFiles: true },
        });

        expect(res.statusCode).toBe(200);
        expect(services.rename.renameBook).toHaveBeenCalledWith(7);
        expect(services.tagging.retagBook).toHaveBeenCalledWith(7, expect.any(Set), {});
      });
    });
  });
});
