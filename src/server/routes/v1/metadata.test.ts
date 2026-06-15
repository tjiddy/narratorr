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

describe('v1 metadata routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1MetadataRoutes(app, { metadataService });
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (metadataService.search as Mock).mockResolvedValue({ books: [], authors: [], series: [] });
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
