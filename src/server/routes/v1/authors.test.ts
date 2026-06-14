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
import type { ReferenceReadService } from '../../services/reference-read.service.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { v1AuthorsRoutes } from './authors.js';
import { authorV1Schema } from '../../../shared/schemas/v1/authors.js';
import { v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';

// Mock config so the auth plugin runs with authBypass off (mirrors books.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

/** A leaky reference row as the service returns it (internal id included). */
function refRow(overrides?: Record<string, unknown>) {
  return { id: 1, publicId: 'au_test000000000000000', name: 'Brandon Sanderson', ...overrides };
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

const referenceReadService = {
  listAuthors: vi.fn(),
  getAuthorById: vi.fn(),
} as unknown as ReferenceReadService;
const db = createMockDb();

describe('v1 authors routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1AuthorsRoutes(app, { referenceReadService }, inject<Db>(db));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (referenceReadService.listAuthors as Mock).mockResolvedValue({ data: [], total: 0 });
    (referenceReadService.getAuthorById as Mock).mockResolvedValue(null);
    db.select.mockReturnValue(mockDbChain([]));
  });

  describe('GET /api/v1/authors', () => {
    it('returns 200 with a { data, total } envelope; each item is { id, name } with an au_ id', async () => {
      (referenceReadService.listAuthors as Mock).mockResolvedValue({ data: [refRow()], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/v1/authors', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'total']);
      expect(body.total).toBe(1);
      expect(body.data[0]).toEqual({ id: 'au_test000000000000000', name: 'Brandon Sanderson' });
      expect(authorV1Schema.parse(body.data[0])).toBeTruthy();
    });

    it('lists an author with zero associated books (base-table read)', async () => {
      (referenceReadService.listAuthors as Mock).mockResolvedValue({ data: [refRow({ name: 'Unlinked Author' })], total: 1 });
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].name).toBe('Unlinked Author');
    });

    it('forwards pagination into listAuthors', async () => {
      await app.inject({ method: 'GET', url: '/api/v1/authors?limit=2&offset=2', headers: keyHeaders });
      expect(referenceReadService.listAuthors as Mock).toHaveBeenCalledTimes(1);
      expect((referenceReadService.listAuthors as Mock).mock.calls[0]![0]).toEqual({ limit: 2, offset: 2 });
    });

    it('returns empty data with the correct total when offset is past the end', async () => {
      (referenceReadService.listAuthors as Mock).mockResolvedValue({ data: [], total: 5 });
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors?offset=100', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 5 });
    });

    it('accepts limit=500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors?limit=500', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
    });

    it.each([
      '/api/v1/authors?limit=0',
      '/api/v1/authors?limit=501',
      '/api/v1/authors?offset=-1',
      '/api/v1/authors?cursor=abc',
      '/api/v1/authors?sort_by=name',
    ])('rejects bad params (%s) with a 400 v1 envelope', async (url) => {
      const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
    });
  });

  describe('GET /api/v1/authors/:publicId', () => {
    it('returns 200 with a single AuthorV1 whose id matches the requested publicId', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 1 }]));
      (referenceReadService.getAuthorById as Mock).mockResolvedValue(refRow());

      const res = await app.inject({ method: 'GET', url: '/api/v1/authors/au_test000000000000000', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 'au_test000000000000000', name: 'Brandon Sanderson' });
    });

    it('returns a 404 v1 envelope for an unknown publicId', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors/au_nope', headers: keyHeaders });
      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
    });

    it('returns a 404 v1 envelope when the publicId resolves but the row is gone', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 5 }]));
      (referenceReadService.getAuthorById as Mock).mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors/au_test000000000000000', headers: keyHeaders });
      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(referenceReadService.getAuthorById as Mock).toHaveBeenCalledWith(5);
    });

    it('returns a 404 v1 envelope for a numeric rowid (opaque-key only)', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors/1', headers: keyHeaders });
      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(referenceReadService.getAuthorById as Mock).not.toHaveBeenCalled();
    });
  });

  describe('auth', () => {
    it('rejects a missing API key with 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid API key with the 401 v1 envelope', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/v1/authors', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      expectV1Envelope(res.json());
    });
  });
});

// Fastify response-schema fail-closed — a handler returning a leaky object must
// FAIL serialization (500), not strip and ship the field.
describe('v1 authors response-schema fail-closed (Fastify serialization)', () => {
  it('rejects a leaked field at serialization instead of stripping it', async () => {
    const leakyApp = Fastify({ logger: false });
    leakyApp.setSerializerCompiler(serializerCompiler);
    leakyApp.get('/leak', { schema: { response: { 200: authorV1Schema } } }, async () => ({
      id: 'au_1',
      name: 'X',
      slug: 'leak',
    }));
    await leakyApp.ready();

    const res = await leakyApp.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('slug');

    await leakyApp.close();
  });
});

function expectV1Envelope(body: unknown): void {
  expect(v1ErrorEnvelopeSchema.safeParse(body).success).toBe(true);
  const b = body as Record<string, unknown>;
  expect(b).not.toHaveProperty('statusCode');
}
