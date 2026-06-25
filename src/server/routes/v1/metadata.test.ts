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
import type { MetadataService } from '../../services/metadata.service.js';
import type { BookService } from '../../services/book.service.js';
import { v1MetadataRoutes } from './metadata.js';
import { metadataSearchResultV1Schema } from '../../../shared/schemas/v1/metadata.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';

// Mock config so the auth plugin runs with authBypass off (mirrors books.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

/** A full `BookMetadata`-shaped provider result (leaky internals included). */
function providerBook(overrides?: Record<string, unknown>) {
  return {
    asin: 'B00ASIN',
    title: 'Wool',
    subtitle: 'Silo Book 1',
    isbn: '9780000000000',
    providerId: 'prov-123',
    description: 'must not leak',
    authors: [{ name: 'Hugh Howey', asin: 'AUASIN' }],
    narrators: ['Minnie Goode'],
    seriesPrimary: { name: 'Silo', position: 1 },
    series: [{ name: 'Silo', position: 1 }],
    coverUrl: 'https://example.com/cover.jpg',
    publishedDate: '2011-07-30',
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

const metadataService = { search: vi.fn() } as unknown as MetadataService;
const bookService = { findLibraryStatusByAsins: vi.fn() } as unknown as BookService;

describe('v1 metadata routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1MetadataRoutes(app, { metadataService, bookService });
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (metadataService.search as Mock).mockResolvedValue({ books: [], authors: [], series: [] });
    (bookService.findLibraryStatusByAsins as Mock).mockResolvedValue(new Map());
  });

  describe('GET /api/v1/metadata/search', () => {
    it('returns 200 with a { data, total } envelope; each item round-trips the result schema', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [providerBook()], authors: [], series: [] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'total']);
      expect(body.total).toBe(1);
      expect(body.total).toBe(body.data.length);
      expect(v1ListResponseSchema(metadataSearchResultV1Schema).safeParse(body).success).toBe(true);
      expect(metadataService.search as Mock).toHaveBeenCalledWith('wool');
    });

    it('does NOT leak internal provider fields (providerId/isbn/description) into the body', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [providerBook()], authors: [], series: [] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const item = res.json().data[0];
      expect(item).not.toHaveProperty('providerId');
      expect(item).not.toHaveProperty('isbn');
      expect(item).not.toHaveProperty('description');
      expect(item).not.toHaveProperty('subtitle');
      expect(item.cover).toBe('https://example.com/cover.jpg');
      expect(item.narrators).toEqual([{ name: 'Minnie Goode' }]);
    });

    it('returns { data: [], total: 0 } with 200 on no match', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [], authors: [], series: [] });

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=nope', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('returns { data: [], total: 0 } with 200 on a rate-limited result; warnings are not exposed', async () => {
      (metadataService.search as Mock).mockResolvedValue({
        books: [],
        authors: [],
        series: [],
        warnings: ['audible rate limit reached, results may be incomplete. Try again in 30s.'],
      });

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ data: [], total: 0 });
      expect(body).not.toHaveProperty('warnings');
    });

    it.each(['/api/v1/metadata/search', '/api/v1/metadata/search?q=', '/api/v1/metadata/search?q=%20%20'])(
      'rejects a missing/blank q (%s) with a 400 v1 envelope',
      async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
      },
    );

    it('rejects an over-length q (>500 chars) with a 400 v1 envelope', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/metadata/search?q=${'a'.repeat(501)}`,
        headers: keyHeaders,
      });
      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
    });

    it('rejects unknown query params with a 400 v1 envelope (strict)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool&limit=10', headers: keyHeaders });
      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
    });
  });

  describe('library cross-reference (#1537)', () => {
    it('annotates a result whose ASIN matches an imported library book', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [providerBook()], authors: [], series: [] });
      (bookService.findLibraryStatusByAsins as Mock).mockResolvedValue(
        new Map([['B00ASIN', { bookId: 'bk_abc123', status: 'imported' }]]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const item = res.json().data[0];
      expect(item.library).toEqual({ bookId: 'bk_abc123', status: 'imported' });
      expect(bookService.findLibraryStatusByAsins as Mock).toHaveBeenCalledWith(['B00ASIN']);
    });

    it('leaves library absent for a result not in the library', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [providerBook()], authors: [], series: [] });
      (bookService.findLibraryStatusByAsins as Mock).mockResolvedValue(new Map());

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json().data[0]).not.toHaveProperty('library');
    });

    it('does not pass an asin-less result to the lookup and leaves it unannotated', async () => {
      (metadataService.search as Mock).mockResolvedValue({
        books: [providerBook({ asin: undefined })],
        authors: [],
        series: [],
      });

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      // No ASINs at all → no lookup issued (avoids an empty IN ()).
      expect(bookService.findLibraryStatusByAsins as Mock).not.toHaveBeenCalled();
      expect(res.json().data[0]).not.toHaveProperty('library');
    });

    it('annotates only the hits in a mixed batch', async () => {
      (metadataService.search as Mock).mockResolvedValue({
        books: [
          providerBook({ asin: 'B00HIT', title: 'Owned' }),
          providerBook({ asin: 'B00MISS', title: 'Not Owned' }),
        ],
        authors: [],
        series: [],
      });
      (bookService.findLibraryStatusByAsins as Mock).mockResolvedValue(
        new Map([['B00HIT', { bookId: 'bk_hit', status: 'downloading' }]]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const [hit, miss] = res.json().data;
      expect(hit.library).toEqual({ bookId: 'bk_hit', status: 'downloading' });
      expect(miss).not.toHaveProperty('library');
      expect(bookService.findLibraryStatusByAsins as Mock).toHaveBeenCalledWith(['B00HIT', 'B00MISS']);
    });

    it('matches a case-drifted ASIN via the uppercased map key', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [providerBook({ asin: 'b00asin' })], authors: [], series: [] });
      // Service normalizes keys to uppercase; the route looks up with toUpperCase().
      (bookService.findLibraryStatusByAsins as Mock).mockResolvedValue(
        new Map([['B00ASIN', { bookId: 'bk_drift', status: 'imported' }]]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].library).toEqual({ bookId: 'bk_drift', status: 'imported' });
    });

    it('returns the normal { data, total } payload with no library fields and no 5xx when the lookup throws, and logs the failure', async () => {
      (metadataService.search as Mock).mockResolvedValue({ books: [providerBook()], authors: [], series: [] });
      const boom = new Error('db down');
      (bookService.findLibraryStatusByAsins as Mock).mockRejectedValue(boom);
      // With logger:false the abstract logger is a singleton, so request.log
      // delegates to app.log — spying on app.log.warn captures the route's
      // request.log.warn on the swallowed enrichment-failure path.
      const warnSpy = vi.spyOn(app.log, 'warn');

      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'total']);
      expect(body.total).toBe(1);
      expect(body.data[0]).not.toHaveProperty('library');
      // The required failure log is emitted (deleting the route's log.warn fails this).
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        'v1 metadata-search library enrichment failed',
      );
      warnSpy.mockRestore();
    });
  });

  describe('auth', () => {
    it('rejects a missing API key with 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid API key with the 401 v1 envelope', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
    });

    it('accepts a valid API key with 200', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(true);
      const res = await app.inject({ method: 'GET', url: '/api/v1/metadata/search?q=wool', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
    });
  });
});

/** Assert a body is the canonical v1 error envelope, NOT the internal `{ statusCode, error, message }`. */
function expectV1Envelope(body: unknown): void {
  expect(v1ErrorEnvelopeSchema.safeParse(body).success).toBe(true);
  const b = body as Record<string, unknown>;
  expect(b).not.toHaveProperty('statusCode');
}
