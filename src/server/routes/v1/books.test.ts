import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cookie from '@fastify/cookie';
import authPlugin from '../../plugins/auth.js';
import type { AuthService } from '../../services/auth.service.js';
import type { Db } from '@db/index.js';
import type { BookService } from '../../services/book.service.js';
import type { BookListService } from '../../services/book-list.service.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { findCompanionEbooksByBookIds } from '../../services/companion-ebook.repository.js';
import { createMockDbBook, createMockDbAuthor } from '../../__tests__/factories.js';
import { v1BooksRoutes } from './books.js';
import { bookV1Schema } from '@shared/schemas/v1/books.js';
import { v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import { triggerImmediateSearch } from '../../services/trigger-immediate-search.js';
import { OwnedRecordingError } from '../../services/book-dedup.js';

vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

// Isolate the fire-and-forget trigger so branch invocation is observable.
vi.mock('../../services/trigger-immediate-search.js', () => ({ triggerImmediateSearch: vi.fn() }));

// Mock the batch-loader boundary to assert id sets and failure degradation directly.
vi.mock('../../services/companion-ebook.repository.js', () => ({
  findCompanionEbooksByBookIds: vi.fn(),
}));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

const narrator = { id: 9, publicId: 'nr_test000000000000000', name: 'Kate Reading', slug: 'kate-reading', createdAt: new Date(), updatedAt: new Date() };

function hydratedRow(overrides?: Record<string, unknown>) {
  return {
    ...createMockDbBook({ status: 'imported', seriesName: 'Stormlight', seriesPosition: 1, ...overrides }),
    authors: [createMockDbAuthor()],
    narrators: [narrator],
    importListName: null,
  };
}

function metaBook(overrides?: Record<string, unknown>) {
  return {
    asin: 'B0ASIN12345',
    title: 'The Way of Kings',
    subtitle: 'Book One of the Stormlight Archive',
    authors: [{ name: 'Brandon Sanderson' }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    description: 'An epic fantasy',
    publisher: 'Macmillan Audio',
    coverUrl: 'https://example.test/cover.jpg',
    isbn: '9780765326355',
    seriesPrimary: { name: 'Stormlight', position: 1, asin: 'B0SERIES000' },
    duration: 2734,
    publishedDate: '2010-08-31',
    genres: ['Fantasy'],
    providerId: 'audible:B0ASIN12345',
    ...overrides,
  };
}

const authService = {
  validateApiKey: vi.fn().mockResolvedValue(true),
  getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
  hasUser: vi.fn().mockResolvedValue(true),
  verifyCredentials: vi.fn().mockResolvedValue(null),
  getSessionSecret: vi.fn().mockResolvedValue('secret'),
  verifySessionCookie: vi.fn().mockReturnValue(null),
  verifyStreamToken: vi.fn().mockReturnValue(null),
  createSessionCookie: vi.fn().mockReturnValue('cookie'),
} as unknown as AuthService;

const bookListService = { getAll: vi.fn() } as unknown as BookListService;
const bookService = { getById: vi.fn(), findDuplicate: vi.fn(), create: vi.fn() } as unknown as BookService;
const metadataService = { lookupForFixMatch: vi.fn() };
const settingsService = { get: vi.fn() };
const eventHistory = { create: vi.fn() };
const db = createMockDb();

// Search-path services stay empty because the trigger is mocked at its module boundary.
function postDeps() {
  return {
    bookService,
    bookListService,
    metadataService: metadataService as never,
    settingsService: settingsService as never,
    eventHistory: eventHistory as never,
    downloadOrchestrator: {} as never,
    indexerSearchService: {} as never,
    indexerService: {} as never,
    blacklistService: {} as never,
  };
}

describe('v1 books routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1BooksRoutes(app, postDeps(), inject<Db>(db));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (bookListService.getAll as Mock).mockResolvedValue({ data: [], total: 0 });
    (bookService.getById as Mock).mockResolvedValue(null);
    (bookService.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
    (bookService.create as Mock).mockResolvedValue(hydratedRow({ status: 'wanted' }));
    (metadataService.lookupForFixMatch as Mock).mockResolvedValue({ kind: 'ok', book: metaBook() });
    (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false, enabled: false });
    (eventHistory.create as Mock).mockResolvedValue(undefined);
    (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map());
    db.select.mockReturnValue(mockDbChain([]));
  });

  describe('GET /api/v1/books', () => {
    it('returns 200 with a { data, total } envelope; each item round-trips bookV1Schema', async () => {
      (bookListService.getAll as Mock).mockResolvedValue({ data: [hydratedRow()], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'total']);
      expect(body.total).toBe(1);
      expect(bookV1Schema.parse(body.data[0])).toBeTruthy();
      expect(body.data[0]).not.toHaveProperty('lastGrabInfoHash');
      expect(body.data[0].id).toBe('bk_test000000000000000');
    });

    it('forwards the canonical status with exactStatus:true (exact-match contract, F1)', async () => {
      await app.inject({ method: 'GET', url: '/api/v1/books?status=downloading', headers: keyHeaders });

      expect(bookListService.getAll as Mock).toHaveBeenCalledTimes(1);
      const [status, , options] = (bookListService.getAll as Mock).mock.calls[0]!;
      expect(status).toBe('downloading');
      expect(options).toMatchObject({ exactStatus: true });
    });

    it('forwards documented filter/sort params (author, series, narrator, sortField, sortDirection) and pagination into getAll', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/v1/books?author=Hugh+Howey&series=Silo&narrator=Minnie+Goode&sortField=title&sortDirection=asc&limit=25&offset=50',
        headers: keyHeaders,
      });

      expect(bookListService.getAll as Mock).toHaveBeenCalledTimes(1);
      const [, pagination, options] = (bookListService.getAll as Mock).mock.calls[0]!;
      expect(options).toMatchObject({
        author: 'Hugh Howey',
        series: 'Silo',
        narrator: 'Minnie Goode',
        sortField: 'title',
        sortDirection: 'asc',
        exactStatus: true,
      });
      expect(pagination).toEqual({ limit: 25, offset: 50 });
    });

    it('returns empty data with the correct total when offset is past the end', async () => {
      (bookListService.getAll as Mock).mockResolvedValue({ data: [], total: 5 });

      const res = await app.inject({ method: 'GET', url: '/api/v1/books?offset=100', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 5 });
    });

    it('accepts limit=500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/books?limit=500', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
    });

    it.each(['/api/v1/books?limit=0', '/api/v1/books?limit=501', '/api/v1/books?offset=-1'])(
      'rejects out-of-bounds pagination (%s) with a 400 v1 envelope',
      async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
      },
    );

    it.each(['/api/v1/books?status=all', '/api/v1/books?status=bogus'])(
      'rejects a non-canonical status (%s) with a 400 v1 envelope',
      async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
      },
    );

    it.each(['/api/v1/books?cursor=abc', '/api/v1/books?sort_by=title'])(
      'rejects unknown query params (%s) with a 400 v1 envelope (strict, #1471)',
      async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
      },
    );
  });

  describe('GET /api/v1/books/:publicId', () => {
    it('returns 200 with a single BookV1 whose id matches the requested publicId', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
      (bookService.getById as Mock).mockResolvedValue(hydratedRow());

      const res = await app.inject({ method: 'GET', url: '/api/v1/books/bk_test000000000000000', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe('bk_test000000000000000');
      expect(bookV1Schema.parse(body)).toBeTruthy();
      expect(body).not.toHaveProperty('lastGrabInfoHash');
    });

    it('returns a 404 v1 envelope for an unknown publicId', async () => {
      db.select.mockReturnValue(mockDbChain([])); // resolveByPublicId → null

      const res = await app.inject({ method: 'GET', url: '/api/v1/books/bk_nope', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
    });

    it('returns a 404 v1 envelope when the publicId resolves but the row is gone (stale/deleted race)', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 5 }])); // resolveByPublicId → rowid
      (bookService.getById as Mock).mockResolvedValue(null); // ...but the row is gone

      const res = await app.inject({ method: 'GET', url: '/api/v1/books/bk_test000000000000000', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(bookService.getById as Mock).toHaveBeenCalledWith(5);
    });

    // Pin the shared trimming schema; a private non-trimming copy would turn whitespace
    // into 404 while schema-only and other-consumer tests remain green.
    it.each(['%20', '%20%20', '%09'])(
      'returns a 400 BAD_REQUEST envelope for the whitespace-only publicId %s, without resolving',
      async (encoded) => {
        const res = await app.inject({ method: 'GET', url: `/api/v1/books/${encoded}`, headers: keyHeaders });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: expect.any(String) } });
        expectV1Envelope(res.json());
        expect(db.select).not.toHaveBeenCalled();
        expect(bookService.getById as Mock).not.toHaveBeenCalled();
      },
    );

    it('returns a 404 v1 envelope for a numeric rowid (opaque-key only)', async () => {
      db.select.mockReturnValue(mockDbChain([])); // a numeric id never matches publicId

      const res = await app.inject({ method: 'GET', url: '/api/v1/books/1', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(bookService.getById as Mock).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/books (add-by-ASIN, #1520)', () => {
    const ASIN = 'B0ASIN12345';
    const post = async (body: object) =>
      app.inject({ method: 'POST', url: '/api/v1/books', headers: keyHeaders, payload: body });

    it('201: creates the book and returns a strict BookV1 (search OFF)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(bookV1Schema.parse(body)).toBeTruthy();
      expect(Object.keys(body).sort()).toEqual(['authors', 'companionEbook', 'id', 'narrators', 'series', 'status', 'title']);
      expect(body).not.toHaveProperty('asin');
      expect(body).not.toHaveProperty('lastGrabInfoHash');
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
      expect(bookService.create as Mock).toHaveBeenCalledTimes(1);
    });

    it('201: fires the immediate search when searchImmediately AND status==wanted', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: true });
      const created = hydratedRow({ status: 'wanted' });
      (bookService.create as Mock).mockResolvedValue(created);

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      expect(triggerImmediateSearch as Mock).toHaveBeenCalledTimes(1);
      const [bookArg] = (triggerImmediateSearch as Mock).mock.calls[0]!;
      expect(bookArg).toBe(created);
    });

    it('does NOT fire the immediate search when status != wanted (gate respects status)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: true });
      (bookService.create as Mock).mockResolvedValue(hydratedRow({ status: 'imported' }));

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('persists the requested ASIN even when the provider record omits asin (retry safety)', async () => {
      (metadataService.lookupForFixMatch as Mock).mockResolvedValue({ kind: 'ok', book: metaBook({ asin: undefined }) });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      const [payload] = (bookService.create as Mock).mock.calls[0]!;
      expect(payload.asin).toBe(ASIN);
    });

    it('maps the FULL metadata record onto the create payload (series from seriesPrimary, F2)', async () => {
      await post({ asin: ASIN });

      const [payload] = (bookService.create as Mock).mock.calls[0]!;
      expect(payload).toEqual({
        title: 'The Way of Kings',
        subtitle: 'Book One of the Stormlight Archive',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer', 'Kate Reading'],
        description: 'An epic fantasy',
        publisher: 'Macmillan Audio',
        coverUrl: 'https://example.test/cover.jpg',
        asin: ASIN, // provider asin present → persisted as-is
        isbn: '9780765326355',
        seriesName: 'Stormlight',
        seriesPosition: 1,
        duration: 2734,
        publishedDate: '2010-08-31',
        genres: ['Fantasy'],
        providerId: 'audible:B0ASIN12345',
      });
    });

    it('falls back to series[0] for series name/position when seriesPrimary is absent (F2)', async () => {
      (metadataService.lookupForFixMatch as Mock).mockResolvedValue({
        kind: 'ok',
        book: metaBook({ seriesPrimary: undefined, series: [{ name: 'Mistborn', position: 3 }] }),
      });

      await post({ asin: ASIN });

      const [payload] = (bookService.create as Mock).mock.calls[0]!;
      expect(payload.seriesName).toBe('Mistborn');
      expect(payload.seriesPosition).toBe(3);
      expect(payload).not.toHaveProperty('seriesAsin');
    });

    it('omits create fields the provider record does not supply (no explicit undefined, F2)', async () => {
      (metadataService.lookupForFixMatch as Mock).mockResolvedValue({
        kind: 'ok',
        book: { title: 'Bare', authors: [{ name: 'Solo' }] },
      });

      await post({ asin: ASIN });

      const [payload] = (bookService.create as Mock).mock.calls[0]!;
      expect(payload).toEqual({
        title: 'Bare',
        authors: [{ name: 'Solo' }],
        asin: ASIN, // provider omitted asin → requested ASIN fallback
      });
      // Missing formatType must not synthesize productionType: 'unknown'.
      for (const key of ['description', 'coverUrl', 'isbn', 'duration', 'publishedDate', 'genres', 'narrators', 'seriesName', 'seriesPosition', 'providerId', 'productionType']) {
        expect(payload).not.toHaveProperty(key);
      }
    });

    it('maps a known formatType to the normalized productionType (#1731)', async () => {
      (metadataService.lookupForFixMatch as Mock).mockResolvedValue({
        kind: 'ok',
        book: metaBook({ formatType: 'Abridged' }),
      });

      await post({ asin: ASIN });

      const [payload] = (bookService.create as Mock).mock.calls[0]!;
      expect(payload.productionType).toBe('abridged');
    });

    it('records a manual book_added event', async () => {
      await post({ asin: ASIN });

      expect(eventHistory.create as Mock).toHaveBeenCalledTimes(1);
      const [event] = (eventHistory.create as Mock).mock.calls[0]!;
      expect(event).toMatchObject({ eventType: 'book_added', source: 'manual' });
    });

    it('409: an existing ASIN returns book_exists + existingId, no create/search', async () => {
      (bookService.findDuplicate as Mock).mockResolvedValue({ verdict: 'same-recording', book: hydratedRow({ publicId: 'bk_existing0000000000' }) });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('book_exists');
      expect(typeof body.error.message).toBe('string');
      expect(body.existingId).toBe('bk_existing0000000000');
      expect(bookService.findDuplicate as Mock).toHaveBeenCalledWith(expect.objectContaining({ title: '', asin: ASIN }));
      expect(bookService.create as Mock).not.toHaveBeenCalled();
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('retry-safe: first POST creates, a second POST of the same ASIN returns 409 + the created existingId (F1)', async () => {
      // The created book carries the requested ASIN, so the retry resolves to it.
      const created = hydratedRow({ publicId: 'bk_created00000000000', status: 'wanted', asin: ASIN });
      (bookService.create as Mock).mockResolvedValue(created);

      const first = await post({ asin: ASIN });
      expect(first.statusCode).toBe(201);
      expect(first.json().id).toBe('bk_created00000000000');

      (bookService.findDuplicate as Mock).mockResolvedValueOnce({ verdict: 'same-recording', book: created });
      const second = await post({ asin: ASIN });

      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.error.code).toBe('book_exists');
      expect(body.existingId).toBe('bk_created00000000000');
      expect(bookService.create as Mock).toHaveBeenCalledTimes(1);
    });

    it('409 on a create-time ASIN race (OwnedRecordingError): book_exists + incumbent existingId, no search (#1723 F8)', async () => {
      (bookService.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null });
      (bookService.create as Mock).mockRejectedValue(
        new OwnedRecordingError({ existingBookId: 5, title: 'The Way of Kings', reason: 'asin-owned' }),
      );
      (bookService.getById as Mock).mockResolvedValue(hydratedRow({ publicId: 'bk_owner00000000000000' }));

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('book_exists');
      expect(typeof body.error.message).toBe('string');
      expect(body.existingId).toBe('bk_owner00000000000000');
      expect(bookService.getById as Mock).toHaveBeenCalledWith(5);
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('422 edition_rejected: a reject-word-matching edition is refused before create (#1545)', async () => {
      // Default metadata title contains "kings".
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false, rejectWords: 'kings' });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('edition_rejected');
      expect(bookService.create as Mock).not.toHaveBeenCalled();
      expect(eventHistory.create as Mock).not.toHaveBeenCalled();
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('201: a configured reject-word that does NOT match the edition is unchanged (#1545)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false, rejectWords: 'dramatized' });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      expect(bookService.create as Mock).toHaveBeenCalledTimes(1);
    });

    it('201: searchImmediately survives the single quality read (regression guard, #1545)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: true, rejectWords: 'dramatized' });
      const created = hydratedRow({ status: 'wanted' });
      (bookService.create as Mock).mockResolvedValue(created);

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      expect(settingsService.get as Mock).toHaveBeenCalledTimes(1);
      expect(triggerImmediateSearch as Mock).toHaveBeenCalledTimes(1);
    });

    it('201 fail-open (deterministic): a thrown quality read creates the book and skips the immediate search (#1545)', async () => {
      (settingsService.get as Mock).mockRejectedValue(new Error('settings unavailable'));
      (bookService.create as Mock).mockResolvedValue(hydratedRow({ status: 'wanted' }));

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(201);
      expect(bookService.create as Mock).toHaveBeenCalledTimes(1);
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('409 still precedes the reject gate even when reject-words are configured (#1545)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false, rejectWords: 'kings' });
      (bookService.findDuplicate as Mock).mockResolvedValue({ verdict: 'same-recording', book: hydratedRow({ publicId: 'bk_existing0000000000' }) });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('book_exists');
      expect(bookService.create as Mock).not.toHaveBeenCalled();
    });

    it.each([['not_found'], ['invalid_record']])(
      '422: provider %s maps to the v1 envelope, no create',
      async (kind) => {
        (metadataService.lookupForFixMatch as Mock).mockResolvedValue({ kind });

        const res = await post({ asin: ASIN });

        expect(res.statusCode).toBe(422);
        expectV1Envelope(res.json());
        expect(bookService.create as Mock).not.toHaveBeenCalled();
      },
    );

    it('429: provider rate_limited maps to the v1 envelope with Retry-After', async () => {
      (metadataService.lookupForFixMatch as Mock).mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 5000 });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(429);
      expectV1Envelope(res.json());
      expect(res.headers['retry-after']).toBe('5');
      expect(bookService.create as Mock).not.toHaveBeenCalled();
    });

    it('502: provider transient_failure maps to a 5xx v1 envelope', async () => {
      (metadataService.lookupForFixMatch as Mock).mockResolvedValue({ kind: 'transient_failure', message: 'boom' });

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(502);
      expectV1Envelope(res.json());
      expect(bookService.create as Mock).not.toHaveBeenCalled();
    });

    it('400: rejects an extra key beyond { asin } (strict request)', async () => {
      const res = await post({ asin: ASIN, title: 'sneaky' });

      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
      expect(metadataService.lookupForFixMatch as Mock).not.toHaveBeenCalled();
    });

    it.each([[''], ['   ']])(
      '400: rejects a blank/whitespace ASIN (%j) before any lookup',
      async (asin) => {
        const res = await post({ asin });

        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
        expect(metadataService.lookupForFixMatch as Mock).not.toHaveBeenCalled();
        expect(bookService.findDuplicate as Mock).not.toHaveBeenCalled();
        expect(bookService.create as Mock).not.toHaveBeenCalled();
      },
    );

    it('400: rejects a missing asin', async () => {
      const res = await post({});
      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
    });
  });

  describe('companionEbook on the v1 book DTO (#1961)', () => {
    const EPUB = { format: 'epub', sizeBytes: 123456 };

    function observation(bookId: number, overrides?: Record<string, unknown>) {
      return { bookId, status: 'available', sizeBytes: 123456, filename: 'x.epub', ...overrides };
    }

    function enableFeature() {
      (settingsService.get as Mock).mockResolvedValue({ enabled: true, searchImmediately: false });
    }

    // Pin the exact key: tagging and discovery also expose `enabled`, so a category
    // swap type-checks and can leave the other behavior tests green.
    describe('reads the companionEpub settings category by exact key', () => {
      it.each([
        ['list', '/api/v1/books'],
        ['detail', '/api/v1/books/bk_test000000000000000'],
      ])('the %s GET issues exactly one settings read, for companionEpub', async (_label, url) => {
        enableFeature();
        const row = hydratedRow({ id: 1, status: 'imported' });
        (bookListService.getAll as Mock).mockResolvedValue({ data: [row], total: 1 });
        db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
        (bookService.getById as Mock).mockResolvedValue(row);
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map([[1, observation(1)]]));

        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect((settingsService.get as Mock).mock.calls).toEqual([['companionEpub']]);
        expect(res.json().companionEbook ?? res.json().data[0].companionEbook).toEqual(EPUB);
      });

      it.each([
        ['list', '/api/v1/books'],
        ['detail', '/api/v1/books/bk_test000000000000000'],
      ])('the %s GET reads companionEpub even when the feature is off (one read, no companion query)', async (_label, url) => {
        (settingsService.get as Mock).mockResolvedValue({ enabled: false });
        const row = hydratedRow({ id: 1, status: 'imported' });
        (bookListService.getAll as Mock).mockResolvedValue({ data: [row], total: 1 });
        db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
        (bookService.getById as Mock).mockResolvedValue(row);

        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect((settingsService.get as Mock).mock.calls).toEqual([['companionEpub']]);
        expect(findCompanionEbooksByBookIds as Mock).not.toHaveBeenCalled();
      });
    });

    describe('GET /api/v1/books (list)', () => {
      const three = [
        hydratedRow({ id: 1, publicId: 'bk_one00000000000000000', status: 'imported' }),
        hydratedRow({ id: 2, publicId: 'bk_two00000000000000000', status: 'imported' }),
        hydratedRow({ id: 3, publicId: 'bk_three000000000000000', status: 'imported' }),
      ];

      it('emits the companion object only for the item that carries an available observation', async () => {
        enableFeature();
        (bookListService.getAll as Mock).mockResolvedValue({ data: three, total: 3 });
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map([[2, observation(2)]]));

        const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        const items = res.json().data;
        expect(items.map((i: { companionEbook: unknown }) => i.companionEbook)).toEqual([null, EPUB, null]);
        // Bare data.map(toBookV1) would pass the array index as companionEbook.
        for (const item of items) {
          expect(typeof item.companionEbook).not.toBe('number');
        }
      });

      it('emits null on every item and never calls the companion loader when the feature is disabled', async () => {
        (settingsService.get as Mock).mockResolvedValue({ enabled: false });
        (bookListService.getAll as Mock).mockResolvedValue({ data: three, total: 3 });

        const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().data.every((i: { companionEbook: unknown }) => i.companionEbook === null)).toBe(true);
        expect(findCompanionEbooksByBookIds as Mock).not.toHaveBeenCalled();
      });

      // Status gating prevents a missing book from advertising a stale observation forever.
      it('emits null for a missing book carrying a stale available observation', async () => {
        enableFeature();
        (bookListService.getAll as Mock).mockResolvedValue({
          data: [hydratedRow({ id: 4, publicId: 'bk_stale0000000000000', status: 'missing' })],
          total: 1,
        });
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map([[4, observation(4)]]));

        const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().data[0].companionEbook).toBeNull();
      });

      it('round-trips sizeBytes: 0 as 0, and maps an available row with a null sizeBytes to null (AC 27/28)', async () => {
        enableFeature();
        (bookListService.getAll as Mock).mockResolvedValue({
          data: [
            hydratedRow({ id: 1, publicId: 'bk_zero00000000000000', status: 'imported' }),
            hydratedRow({ id: 2, publicId: 'bk_nosize000000000000', status: 'imported' }),
          ],
          total: 2,
        });
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(
          new Map([
            [1, observation(1, { sizeBytes: 0 })],
            [2, observation(2, { sizeBytes: null })],
          ]),
        );

        const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        const [zero, noSize] = res.json().data;
        expect(zero.companionEbook).toEqual({ format: 'epub', sizeBytes: 0 });
        expect(noSize.companionEbook).toBeNull();
      });

      it('calls the companion loader ONCE with every page id (no N+1)', async () => {
        enableFeature();
        const page = Array.from({ length: 25 }, (_, i) =>
          hydratedRow({ id: i + 1, publicId: `bk_p${String(i).padStart(19, '0')}`, status: 'imported' }),
        );
        (bookListService.getAll as Mock).mockResolvedValue({ data: page, total: 25 });

        await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(findCompanionEbooksByBookIds as Mock).toHaveBeenCalledTimes(1);
        const [, ids] = (findCompanionEbooksByBookIds as Mock).mock.calls[0]!;
        expect(ids).toEqual(page.map((r) => r.id));
      });

      it('hands a max-size (limit=500) page to the loader in ONE call carrying all 500 ids', async () => {
        enableFeature();
        const page = Array.from({ length: 500 }, (_, i) =>
          hydratedRow({ id: i + 1, publicId: `bk_q${String(i).padStart(19, '0')}`, status: 'wanted' }),
        );
        (bookListService.getAll as Mock).mockResolvedValue({ data: page, total: 500 });

        const res = await app.inject({ method: 'GET', url: '/api/v1/books?limit=500', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(findCompanionEbooksByBookIds as Mock).toHaveBeenCalledTimes(1);
        expect((findCompanionEbooksByBookIds as Mock).mock.calls[0]![1]).toHaveLength(500);
      });

      // 500 exceeds the 480-id chunk size; assert the real loader rather than the mocked route seam.
      it('the real loader turns those 500 ids into exactly 2 selects (480-id chunking)', async () => {
        const { findCompanionEbooksByBookIds: real } = await vi.importActual<
          typeof import('../../services/companion-ebook.repository.js')
        >('../../services/companion-ebook.repository.js');
        const chunkDb = createMockDb();
        chunkDb.select.mockReturnValue(mockDbChain([]));

        await real(inject(chunkDb), Array.from({ length: 500 }, (_, i) => i + 1));

        expect(chunkDb.select).toHaveBeenCalledTimes(2);
      });

      it('returns 200 with every companionEbook null and one warn when the settings read rejects', async () => {
        (settingsService.get as Mock).mockRejectedValue(new Error('settings db down'));
        (bookListService.getAll as Mock).mockResolvedValue({ data: three, total: 3 });
        const warnSpy = vi.spyOn(app.log, 'warn');

        const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        const items = res.json().data;
        expect(items).toHaveLength(3);
        expect(items.every((i: { companionEbook: unknown }) => i.companionEbook === null)).toBe(true);
        expect(items[0].id).toBe('bk_one00000000000000000');
        expect(items[0].title).toBe('The Way of Kings');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.anything() }),
          expect.stringContaining('companion-ebook enrichment failed'),
        );
        warnSpy.mockRestore();
      });

      it('returns 200 with every companionEbook null and one warn when the companion read rejects', async () => {
        enableFeature();
        (bookListService.getAll as Mock).mockResolvedValue({ data: three, total: 3 });
        (findCompanionEbooksByBookIds as Mock).mockRejectedValue(new Error('companion table locked'));
        const warnSpy = vi.spyOn(app.log, 'warn');

        const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().data.every((i: { companionEbook: unknown }) => i.companionEbook === null)).toBe(true);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
      });
    });

    describe('GET /api/v1/books/:publicId (detail)', () => {
      const URL = '/api/v1/books/bk_test000000000000000';

      function resolvesTo(row: Record<string, unknown>) {
        db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
        (bookService.getById as Mock).mockResolvedValue(row);
      }

      it('emits the companion VALUE { format, sizeBytes } for an eligible book (AC 23)', async () => {
        enableFeature();
        resolvesTo(hydratedRow({ id: 1, status: 'imported' }));
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map([[1, observation(1)]]));

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().companionEbook).toEqual({ format: 'epub', sizeBytes: 123456 });
      });

      it('emits null and issues NO companion query when the feature is disabled (AC 23)', async () => {
        (settingsService.get as Mock).mockResolvedValue({ enabled: false });
        resolvesTo(hydratedRow({ id: 1, status: 'imported' }));

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().companionEbook).toBeNull();
        expect(findCompanionEbooksByBookIds as Mock).not.toHaveBeenCalled();
      });

      it('emits null for an imported book with no observation row', async () => {
        enableFeature();
        resolvesTo(hydratedRow({ id: 1, status: 'imported' }));
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map());

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().companionEbook).toBeNull();
      });

      it('emits null for a missing book carrying a stale available observation (AC 22)', async () => {
        enableFeature();
        resolvesTo(hydratedRow({ id: 1, status: 'missing' }));
        (findCompanionEbooksByBookIds as Mock).mockResolvedValue(new Map([[1, observation(1)]]));

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().companionEbook).toBeNull();
      });

      it('returns 200 with companionEbook: null and one warn when the settings read rejects (AC 23a)', async () => {
        (settingsService.get as Mock).mockRejectedValue(new Error('settings db down'));
        resolvesTo(hydratedRow({ id: 1, status: 'imported' }));
        const warnSpy = vi.spyOn(app.log, 'warn');

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().companionEbook).toBeNull();
        expect(res.json().id).toBe('bk_test000000000000000');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
      });

      it('returns 200 with companionEbook: null and one warn when the companion read rejects (AC 23a)', async () => {
        enableFeature();
        resolvesTo(hydratedRow({ id: 1, status: 'imported' }));
        (findCompanionEbooksByBookIds as Mock).mockRejectedValue(new Error('companion table locked'));
        const warnSpy = vi.spyOn(app.log, 'warn');

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(200);
        expect(res.json().companionEbook).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
      });

      it('still 404s a genuinely missing book while the companion read is failing (AC 23a scope limit)', async () => {
        enableFeature();
        db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
        (bookService.getById as Mock).mockResolvedValue(null);
        (findCompanionEbooksByBookIds as Mock).mockRejectedValue(new Error('companion table locked'));

        const res = await app.inject({ method: 'GET', url: URL, headers: keyHeaders });

        expect(res.statusCode).toBe(404);
        expectV1Envelope(res.json());
      });
    });

    describe('POST /api/v1/books (create)', () => {
      it('returns 201 with companionEbook: null and reads no companion state at all (AC 24)', async () => {
        (bookService.create as Mock).mockResolvedValue(hydratedRow({ status: 'wanted' }));

        const res = await app.inject({
          method: 'POST', url: '/api/v1/books', headers: keyHeaders, payload: { asin: 'B0ASIN12345' },
        });

        expect(res.statusCode).toBe(201);
        expect(res.json().companionEbook).toBeNull();
        expect(findCompanionEbooksByBookIds as Mock).not.toHaveBeenCalled();
        expect(settingsService.get as Mock).toHaveBeenCalledTimes(1);
        expect(settingsService.get as Mock).not.toHaveBeenCalledWith('companionEpub');
      });
    });
  });

  describe('auth (real auth-plugin fixture, F3)', () => {
    it('rejects a missing API key with 401 (status only — missing key → ambient auth body, not the v1 envelope)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/books' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid API key with the 401 v1 envelope (#1472)', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
      expectV1Envelope(body);
    });

    it('accepts a valid API key with 200', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(true);
      const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
    });
  });
});

// Exercise Fastify serialization itself; direct schema parsing cannot prove fail-closed wiring.
describe('v1 response-schema fail-closed (Fastify serialization, F6)', () => {
  it('rejects a leaked field at serialization instead of stripping it', async () => {
    const leakyApp = Fastify({ logger: false });
    leakyApp.setSerializerCompiler(serializerCompiler);
    leakyApp.get('/leak', { schema: { response: { 200: bookV1Schema } } }, async () => ({
      id: 'bk_1',
      title: 'X',
      authors: [],
      narrators: [],
      series: null,
      status: 'imported',
      companionEbook: null,
      lastGrabInfoHash: 'leak',
    }));
    await leakyApp.ready();

    const res = await leakyApp.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('lastGrabInfoHash');

    await leakyApp.close();
  });
});

function expectV1Envelope(body: unknown): void {
  expect(v1ErrorEnvelopeSchema.safeParse(body).success).toBe(true);
  const b = body as Record<string, unknown>;
  expect(b).not.toHaveProperty('statusCode');
  expect(typeof (b.error as Record<string, unknown>).code).toBe('string');
  expect(typeof (b.error as Record<string, unknown>).message).toBe('string');
}
