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

// Mock config so the auth plugin runs with authBypass off (mirrors auth.plugin.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

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
const bookService = { getById: vi.fn() } as unknown as BookService;
const db = createMockDb();

describe('v1 books routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1BooksRoutes(app, { bookService, bookListService }, inject<Db>(db));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (bookListService.getAll as Mock).mockResolvedValue({ data: [], total: 0 });
    (bookService.getById as Mock).mockResolvedValue(null);
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
