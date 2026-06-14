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
import type { DownloadService } from '../../services/download.service.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { createMockDbBook } from '../../__tests__/factories.js';
import { v1DownloadsRoutes } from './downloads.js';
import { downloadV1Schema } from '../../../shared/schemas/v1/downloads.js';
import { v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';

// Mock config so the auth plugin runs with authBypass off (mirrors books.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

/** A hydrated DownloadWithBook row as the service returns it (leaky internals,
 *  Date timestamps, left-joined book, derived display status + indexerName). */
function hydratedDownload(overrides?: Record<string, unknown>) {
  return {
    id: 42,
    publicId: 'dl_test000000000000000',
    bookId: 7,
    indexerId: 3,
    downloadClientId: 2,
    title: 'Wool (Unabridged)',
    protocol: 'torrent' as const,
    infoHash: 'hash-leak',
    downloadUrl: 'http://leak.example/torrent',
    size: 123456,
    seeders: 12,
    clientStatus: 'completed' as const,
    pipelineStage: 'idle' as const,
    progress: 1,
    externalId: 'ext-leak',
    errorMessage: null as string | null,
    guid: 'guid-leak',
    outputPath: '/downloads/wool',
    bookStatusAtGrab: null,
    addedAt: new Date('2024-01-02T03:04:05.000Z'),
    completedAt: new Date('2024-01-02T04:05:06.000Z') as Date | null,
    progressUpdatedAt: null,
    pendingCleanup: null,
    status: 'completed' as const,
    indexerName: 'AudioBookBay',
    book: createMockDbBook({ id: 7, publicId: 'bk_test000000000000000' }),
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

const downloadService = { getAll: vi.fn(), getById: vi.fn() } as unknown as DownloadService;
const db = createMockDb();

describe('v1 downloads routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1DownloadsRoutes(app, { downloadService }, inject<Db>(db));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (downloadService.getAll as Mock).mockResolvedValue({ data: [], total: 0 });
    (downloadService.getById as Mock).mockResolvedValue(null);
    db.select.mockReturnValue(mockDbChain([]));
  });

  describe('GET /api/v1/downloads', () => {
    it('returns 200 with a { data, total } envelope; each item round-trips downloadV1Schema with no leaks', async () => {
      (downloadService.getAll as Mock).mockResolvedValue({ data: [hydratedDownload()], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'total']);
      expect(body.total).toBe(1);
      expect(downloadV1Schema.parse(body.data[0])).toBeTruthy();
      expect(body.data[0].id).toBe('dl_test000000000000000');
      expect(body.data[0].book).toEqual({ id: 'bk_test000000000000000' });
      // Date -> ISO string survives real Fastify serialization.
      expect(typeof body.data[0].addedAt).toBe('string');
      expect(body.data[0].addedAt).toBe('2024-01-02T03:04:05.000Z');
      // No internal leaks shipped through serialization.
      for (const field of ['infoHash', 'downloadUrl', 'guid', 'externalId', 'outputPath', 'bookId', 'indexerId', 'downloadClientId', 'indexerName']) {
        expect(body.data[0]).not.toHaveProperty(field);
      }
    });

    it('forwards pagination (limit, offset) to downloadService.getAll', async () => {
      await app.inject({ method: 'GET', url: '/api/v1/downloads?limit=25&offset=50', headers: keyHeaders });

      expect(downloadService.getAll as Mock).toHaveBeenCalledTimes(1);
      const [status, pagination] = (downloadService.getAll as Mock).mock.calls[0]!;
      expect(status).toBeUndefined();
      expect(pagination).toEqual({ limit: 25, offset: 50 });
    });

    it('returns empty data with the correct total when offset is past the end', async () => {
      (downloadService.getAll as Mock).mockResolvedValue({ data: [], total: 5 });

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads?offset=100', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 5 });
    });

    it('accepts limit=500', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads?limit=500', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
    });

    it.each(['/api/v1/downloads?limit=0', '/api/v1/downloads?limit=501', '/api/v1/downloads?offset=-1'])(
      'rejects out-of-bounds pagination (%s) with a 400 v1 envelope',
      async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
      },
    );

    it.each(['/api/v1/downloads?cursor=abc', '/api/v1/downloads?sort_by=title', '/api/v1/downloads?status=completed'])(
      'rejects unknown/snake_case query params (%s) with a 400 v1 envelope (strict)',
      async (url) => {
        const res = await app.inject({ method: 'GET', url, headers: keyHeaders });
        expect(res.statusCode).toBe(400);
        expectV1Envelope(res.json());
      },
    );

    it('serializes a download with no linked book as book: null (no throw, 200)', async () => {
      const { book, ...noBook } = hydratedDownload();
      void book;
      (downloadService.getAll as Mock).mockResolvedValue({ data: [noBook], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].book).toBeNull();
    });
  });

  describe('GET /api/v1/downloads/:publicId', () => {
    it('returns 200 with a single DownloadV1 whose id matches the requested publicId', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 42 }]));
      (downloadService.getById as Mock).mockResolvedValue(hydratedDownload());

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads/dl_test000000000000000', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe('dl_test000000000000000');
      expect(downloadV1Schema.parse(body)).toBeTruthy();
      expect(body).not.toHaveProperty('infoHash');
      expect(downloadService.getById as Mock).toHaveBeenCalledWith(42);
    });

    it('returns a 404 v1 envelope for an unknown publicId', async () => {
      db.select.mockReturnValue(mockDbChain([])); // resolveByPublicId → null

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads/dl_nope', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(downloadService.getById as Mock).not.toHaveBeenCalled();
    });

    it('returns a 404 v1 envelope when the publicId resolves but the row is gone (stale race)', async () => {
      db.select.mockReturnValue(mockDbChain([{ id: 5 }]));
      (downloadService.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads/dl_test000000000000000', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(downloadService.getById as Mock).toHaveBeenCalledWith(5);
    });

    it('returns a 404 v1 envelope for a numeric rowid (opaque-key only, never fetched by rowid)', async () => {
      db.select.mockReturnValue(mockDbChain([])); // a numeric id never matches publicId

      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads/42', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(downloadService.getById as Mock).not.toHaveBeenCalled();
    });
  });

  describe('auth (real auth-plugin fixture)', () => {
    it('rejects a missing API key with 401 (status only — ambient body, not the v1 envelope)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid API key with the 401 v1 envelope', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
      expectV1Envelope(body);
    });

    it('accepts a valid API key with 200', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(true);
      const res = await app.inject({ method: 'GET', url: '/api/v1/downloads', headers: keyHeaders });
      expect(res.statusCode).toBe(200);
    });
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
