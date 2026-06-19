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
import type { Db } from '../../../db/index.js';
import type { BookService } from '../../services/book.service.js';
import type { BookListService } from '../../services/book-list.service.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../../__tests__/factories.js';
import { v1BooksRoutes } from './books.js';
import { bookV1Schema } from '../../../shared/schemas/v1/books.js';
import { v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { triggerImmediateSearch } from '../../services/trigger-immediate-search.js';

// Mock config so the auth plugin runs with authBypass off (mirrors auth.plugin.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

// The immediate-search trigger is fire-and-forget; mock it so we can assert
// whether the operator-gated branch invoked it without touching real services.
vi.mock('../../services/trigger-immediate-search.js', () => ({ triggerImmediateSearch: vi.fn() }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

const narrator = { id: 9, publicId: 'nr_test000000000000000', name: 'Kate Reading', slug: 'kate-reading', createdAt: new Date(), updatedAt: new Date() };

/** A hydrated BookWithAuthor row as the services return it (leaky internals included). */
function hydratedRow(overrides?: Record<string, unknown>) {
  return {
    ...createMockDbBook({ status: 'imported', seriesName: 'Stormlight', seriesPosition: 1, ...overrides }),
    authors: [createMockDbAuthor()],
    narrators: [narrator],
    importListName: null,
  };
}

/** An ok `BookMetadata` record as `lookupForFixMatch` returns it. */
function metaBook(overrides?: Record<string, unknown>) {
  return {
    asin: 'B0ASIN12345',
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson' }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    description: 'An epic fantasy',
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

/** The full POST dep set. Search-path services are unused stubs because the
 *  immediate-search trigger itself is mocked at the module boundary. */
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
    (bookService.findDuplicate as Mock).mockResolvedValue(null);
    (bookService.create as Mock).mockResolvedValue(hydratedRow({ status: 'wanted' }));
    (metadataService.lookupForFixMatch as Mock).mockResolvedValue({ kind: 'ok', book: metaBook() });
    (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false });
    (eventHistory.create as Mock).mockResolvedValue(undefined);
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
      // No internal leaks shipped through serialization.
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
      // Every documented filter/sort param must reach the service — deleting any
      // conditional spread in the route would drop it here while the request still 200s.
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

      // The row-null guard must produce the required v1 404 envelope, not a projection 500.
      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(bookService.getById as Mock).toHaveBeenCalledWith(5);
    });

    it('returns a 404 v1 envelope for a numeric rowid (opaque-key only)', async () => {
      db.select.mockReturnValue(mockDbChain([])); // a numeric id never matches publicId

      const res = await app.inject({ method: 'GET', url: '/api/v1/books/1', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      // The numeric value never reached getById — resolution failed first.
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
      // DTO no-leak: exactly the BookV1 keys, nothing internal.
      expect(Object.keys(body).sort()).toEqual(['authors', 'id', 'narrators', 'series', 'status', 'title']);
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
      // Every mapped field is asserted by value — deleting any single mapping
      // (description/coverUrl/isbn/duration/publishedDate/genres/series*) would
      // fail here, not silently survive.
      expect(payload).toEqual({
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer', 'Kate Reading'],
        description: 'An epic fantasy',
        coverUrl: 'https://example.test/cover.jpg',
        asin: ASIN, // provider asin present → persisted as-is
        isbn: '9780765326355',
        seriesName: 'Stormlight',
        seriesPosition: 1,
        seriesAsin: 'B0SERIES000',
        seriesProvider: 'audible',
        duration: 2734,
        publishedDate: '2010-08-31',
        genres: ['Fantasy'],
        providerId: 'audible:B0ASIN12345',
      });
    });

    it('falls back to series[0] for series name/position when seriesPrimary is absent (F2)', async () => {
      // No seriesPrimary, but a series array → primarySeries = series[0]; seriesAsin
      // is sourced ONLY from seriesPrimary, so it must be absent in the fallback case.
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
      // A minimal ok record: only the required title/authors plus the requested ASIN.
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
        seriesProvider: 'audible',
      });
      // Unsupplied optional fields must be ABSENT, not present-as-undefined.
      for (const key of ['description', 'coverUrl', 'isbn', 'duration', 'publishedDate', 'genres', 'narrators', 'seriesName', 'seriesPosition', 'seriesAsin', 'providerId']) {
        expect(payload).not.toHaveProperty(key);
      }
    });

    it('records a manual book_added event', async () => {
      await post({ asin: ASIN });

      expect(eventHistory.create as Mock).toHaveBeenCalledTimes(1);
      const [event] = (eventHistory.create as Mock).mock.calls[0]!;
      expect(event).toMatchObject({ eventType: 'book_added', source: 'manual' });
    });

    it('409: an existing ASIN returns book_exists + existingId, no create/search', async () => {
      (bookService.findDuplicate as Mock).mockResolvedValue(hydratedRow({ publicId: 'bk_existing0000000000' }));

      const res = await post({ asin: ASIN });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error.code).toBe('book_exists');
      expect(typeof body.error.message).toBe('string');
      expect(body.existingId).toBe('bk_existing0000000000');
      expect(bookService.findDuplicate as Mock).toHaveBeenCalledWith('', undefined, ASIN);
      expect(bookService.create as Mock).not.toHaveBeenCalled();
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('retry-safe: first POST creates, a second POST of the same ASIN returns 409 + the created existingId (F1)', async () => {
      // The created book carries the requested ASIN, so the next find-by-ASIN
      // resolves to it. findDuplicate base (beforeEach) is null → first POST creates.
      const created = hydratedRow({ publicId: 'bk_created00000000000', status: 'wanted', asin: ASIN });
      (bookService.create as Mock).mockResolvedValue(created);

      const first = await post({ asin: ASIN });
      expect(first.statusCode).toBe(201);
      expect(first.json().id).toBe('bk_created00000000000');

      // Lost-response retry: the same ASIN now finds the created row → 409, no second create.
      (bookService.findDuplicate as Mock).mockResolvedValueOnce(created);
      const second = await post({ asin: ASIN });

      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.error.code).toBe('book_exists');
      expect(body.existingId).toBe('bk_created00000000000');
      // The retry produced no second book.
      expect(bookService.create as Mock).toHaveBeenCalledTimes(1);
    });

    it('422 edition_rejected: a reject-word-matching edition is refused before create (#1545)', async () => {
      // metaBook title is "The Way of Kings" → reject-word "kings" matches the surface.
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
      // The reject gate and the post-create immediate search now share ONE read —
      // assert reusing the captured value did not drop the search.
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

      // Single read ⇒ the throw cannot create-then-500: 201, book created, no search.
      expect(res.statusCode).toBe(201);
      expect(bookService.create as Mock).toHaveBeenCalledTimes(1);
      expect(triggerImmediateSearch as Mock).not.toHaveBeenCalled();
    });

    it('409 still precedes the reject gate even when reject-words are configured (#1545)', async () => {
      (settingsService.get as Mock).mockResolvedValue({ searchImmediately: false, rejectWords: 'kings' });
      (bookService.findDuplicate as Mock).mockResolvedValue(hydratedRow({ publicId: 'bk_existing0000000000' }));

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

  describe('auth (real auth-plugin fixture, F3)', () => {
    it('rejects a missing API key with 401 (status only — missing key → ambient auth body, not the v1 envelope)', async () => {
      // A no-key request falls through to handleAmbientAuth, which returns the
      // ambient body (not a v1 envelope), so this case is genuinely envelope-exempt.
      const res = await app.inject({ method: 'GET', url: '/api/v1/books' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid API key with the 401 v1 envelope (#1472)', async () => {
      // An invalid (presented-but-rejected) key on a native v1 route now returns the
      // canonical v1 envelope, built in the auth hook before this route's handler.
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

// F6 — prove Fastify response-schema enforcement is actually wired (not just that
// the schema rejects via direct parse). A route declaring `response: bookV1Schema`
// whose handler returns a leaky object must FAIL serialization (5xx), not strip
// and ship the field. This pins the keystone behavior at the Fastify layer.
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
      lastGrabInfoHash: 'leak',
    }));
    await leakyApp.ready();

    const res = await leakyApp.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('lastGrabInfoHash');

    await leakyApp.close();
  });
});

/** Assert a body is the canonical v1 error envelope, NOT the internal `{ statusCode, error, message }`. */
function expectV1Envelope(body: unknown): void {
  expect(v1ErrorEnvelopeSchema.safeParse(body).success).toBe(true);
  const b = body as Record<string, unknown>;
  expect(b).not.toHaveProperty('statusCode');
  expect(typeof (b.error as Record<string, unknown>).code).toBe('string');
  expect(typeof (b.error as Record<string, unknown>).message).toBe('string');
}
