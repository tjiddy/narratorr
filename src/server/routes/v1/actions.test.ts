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
import type { IndexerSearchService } from '../../services/indexer-search.service.js';
import type { DownloadOrchestrator } from '../../services/download-orchestrator.js';
import type { DownloadService } from '../../services/download.service.js';
import { DuplicateDownloadError } from '../../services/download.service.js';
import { DownloadClientError, DownloadClientAuthError, DownloadClientTimeoutError } from '../../../core/download-clients/errors.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../../__tests__/factories.js';
import { v1ActionsRoutes } from './actions.js';
import { releaseV1Schema, encodeReleaseId } from '../../../shared/schemas/v1/actions.js';
import { downloadV1Schema } from '../../../shared/schemas/v1/downloads.js';
import { v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';

// Mock config so the auth plugin runs with authBypass off (mirrors books.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };
const BOOK_ID = 1;

/** A hydrated BookWithAuthor row as bookService.getById returns it. */
function hydratedBook(overrides?: Record<string, unknown>) {
  return {
    ...createMockDbBook({ id: BOOK_ID, ...overrides }),
    authors: [createMockDbAuthor()],
  };
}

/** A SearchResult-shaped row as IndexerSearchService.searchAll returns it. */
function searchResult(overrides?: Record<string, unknown>) {
  return {
    title: 'The Way of Kings (Unabridged)',
    author: 'Brandon Sanderson',
    narrator: 'Michael Kramer',
    protocol: 'torrent' as const,
    downloadUrl: 'http://indexer.example/torrent/1',
    infoHash: 'ABCDEF0123',
    guid: 'guid-1',
    indexerId: 3,
    indexer: 'AudioBookBay',
    size: 123456,
    seeders: 12,
    isFreeleech: false,
    matchScore: 0.95,
    ...overrides,
  };
}

/** A hydrated DownloadWithBook row as downloadOrchestrator.grab / getById return. */
function hydratedDownload(overrides?: Record<string, unknown>) {
  return {
    id: 42,
    publicId: 'dl_test000000000000000',
    bookId: BOOK_ID,
    indexerId: 3,
    downloadClientId: 2,
    title: 'The Way of Kings (Unabridged)',
    protocol: 'torrent' as const,
    infoHash: 'abcdef0123',
    downloadUrl: 'http://leak.example/torrent',
    size: 123456,
    seeders: 12,
    clientStatus: 'downloading' as const,
    pipelineStage: 'idle' as const,
    progress: 0,
    externalId: 'ext-1',
    errorMessage: null as string | null,
    guid: 'guid-1',
    outputPath: null,
    bookStatusAtGrab: null,
    addedAt: new Date('2024-01-02T03:04:05.000Z'),
    completedAt: null as Date | null,
    progressUpdatedAt: null,
    pendingCleanup: null,
    status: 'downloading' as const,
    indexerName: 'AudioBookBay',
    book: createMockDbBook({ id: BOOK_ID, publicId: 'bk_test000000000000000' }),
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

const bookService = { getById: vi.fn() } as unknown as BookService;
const indexerSearchService = { searchAll: vi.fn() } as unknown as IndexerSearchService;
const downloadOrchestrator = { grab: vi.fn() } as unknown as DownloadOrchestrator;
const downloadService = { getById: vi.fn() } as unknown as DownloadService;
const db = createMockDb();

// Per-test mutable state driving the smart db.select impl: resolveByPublicId
// selects only `{ id }` (→ bookRows); the dedup lookup selects several download
// columns (→ downloadRows).
let bookRows: Array<{ id: number }>;
let downloadRows: Array<Record<string, unknown>>;

describe('v1 action routes (search + grab)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    await v1ActionsRoutes(app, { bookService, indexerSearchService, downloadOrchestrator, downloadService }, inject<Db>(db));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    (authService.getStatus as Mock).mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false });
    (bookService.getById as Mock).mockResolvedValue(hydratedBook());
    (indexerSearchService.searchAll as Mock).mockResolvedValue([]);
    (downloadService.getById as Mock).mockResolvedValue(null);
    (downloadOrchestrator.grab as Mock).mockResolvedValue(hydratedDownload());
    bookRows = [{ id: BOOK_ID }];
    downloadRows = [];
    db.select.mockImplementation((proj?: Record<string, unknown>) => {
      const keys = proj ? Object.keys(proj) : [];
      // resolveByPublicId selects exactly { id }; the dedup lookup selects more.
      if (keys.length === 1 && keys[0] === 'id') return mockDbChain(bookRows);
      return mockDbChain(downloadRows);
    });
  });

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------

  describe('POST /api/v1/books/:publicId/search', () => {
    it('returns a 404 v1 envelope for an unknown publicId', async () => {
      bookRows = []; // resolveByPublicId → null

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_nope/search', headers: keyHeaders });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(indexerSearchService.searchAll as Mock).not.toHaveBeenCalled();
    });

    it('returns 200 with a { data, total } envelope of opaque releases (no raw downloadUrl/infoHash/guid)', async () => {
      (indexerSearchService.searchAll as Mock).mockResolvedValue([searchResult(), searchResult({ guid: 'guid-2', title: 'Words of Radiance' })]);

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['data', 'total']);
      expect(body.total).toBe(2);
      for (const item of body.data) {
        expect(releaseV1Schema.parse(item)).toBeTruthy();
        expect(typeof item.releaseId).toBe('string');
        for (const leak of ['downloadUrl', 'infoHash', 'guid', 'indexerId']) {
          expect(item).not.toHaveProperty(leak);
        }
      }
    });

    it('feeds the resolved book into the query and forwards { title, author } to searchAll', async () => {
      (indexerSearchService.searchAll as Mock).mockResolvedValue([]);

      await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search', headers: keyHeaders });

      expect(indexerSearchService.searchAll as Mock).toHaveBeenCalledTimes(1);
      const [query, options] = (indexerSearchService.searchAll as Mock).mock.calls[0]!;
      expect(query).toContain('Way of Kings');
      expect(query).toContain('Brandon Sanderson');
      expect(options).toEqual({ title: 'The Way of Kings', author: 'Brandon Sanderson' });
    });

    it('returns 200 { data: [], total: 0 } on an empty result set (not 404, not an error)', async () => {
      (indexerSearchService.searchAll as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search', headers: keyHeaders });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    it('returns a 400 v1 envelope when the derived query normalizes to empty (searchAll never called)', async () => {
      (bookService.getById as Mock).mockResolvedValue({ ...createMockDbBook({ id: BOOK_ID, title: '...' }), authors: [] });

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search', headers: keyHeaders });

      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
      expect(indexerSearchService.searchAll as Mock).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Grab — happy path
  // --------------------------------------------------------------------------

  describe('POST /api/v1/books/:publicId/grab — happy path', () => {
    it('grabs once and returns 201 with the download serialized via toDownloadV1 (internals stripped)', async () => {
      const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3 });

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(downloadV1Schema.parse(body)).toBeTruthy();
      expect(body.id).toBe('dl_test000000000000000');
      for (const leak of ['infoHash', 'downloadUrl', 'guid', 'externalId', 'bookId', 'indexerId']) {
        expect(body).not.toHaveProperty(leak);
      }
      expect(downloadOrchestrator.grab as Mock).toHaveBeenCalledTimes(1);
      const [params] = (downloadOrchestrator.grab as Mock).mock.calls[0]!;
      expect(params).toMatchObject({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3, bookId: BOOK_ID });
    });
  });

  // --------------------------------------------------------------------------
  // Grab — idempotency
  // --------------------------------------------------------------------------

  describe('POST /api/v1/books/:publicId/grab — idempotency', () => {
    /** Wire grab so the first call "persists" a matching row for the dedup lookup. */
    function grabPersistsRow(row?: Record<string, unknown>) {
      (downloadOrchestrator.grab as Mock).mockImplementation(async () => {
        downloadRows.push({ id: 42, guid: 'guid-1', infoHash: null, downloadUrl: 'http://x/1', indexerId: 3, ...row });
        return hydratedDownload();
      });
      (downloadService.getById as Mock).mockResolvedValue(hydratedDownload());
    }

    it('serial retry returns 200 with the same publicId and grabs only once', async () => {
      grabPersistsRow();
      const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3 });
      const req = () => app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

      const first = await req();
      const second = await req();

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(first.json().id).toBe(second.json().id);
      expect(downloadOrchestrator.grab as Mock).toHaveBeenCalledTimes(1);
    });

    it('terminal-state retry still returns the existing record (200, same publicId), not 409 and not a new grab', async () => {
      // Existing row is already terminal (completed/imported) — replay must still dedup.
      downloadRows = [{ id: 42, guid: 'guid-1', infoHash: null, downloadUrl: 'http://x/1', indexerId: 3 }];
      (downloadService.getById as Mock).mockResolvedValue(hydratedDownload({ clientStatus: 'completed', pipelineStage: 'imported', progress: 1 }));
      const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3 });

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('dl_test000000000000000');
      expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
    });

    it('concurrent double-submit resolves to one row; the loser returns the winner (200), keyed by (bookId, identity)', async () => {
      let grabCalls = 0;
      (downloadOrchestrator.grab as Mock).mockImplementation(async () => {
        grabCalls++;
        await new Promise((r) => setImmediate(r)); // yield so both handlers reach the lock
        downloadRows.push({ id: 42, guid: 'guid-1', infoHash: null, downloadUrl: 'http://x/1', indexerId: 3 });
        return hydratedDownload();
      });
      (downloadService.getById as Mock).mockResolvedValue(hydratedDownload());
      const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3 });
      const req = () => app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

      const [a, b] = await Promise.all([req(), req()]);

      expect(grabCalls).toBe(1);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      expect(a.json().id).toBe(b.json().id);
    });

    describe('matching-predicate coverage (F2)', () => {
      it('(a) matches a row carrying both guid and info_hash by guid', async () => {
        downloadRows = [{ id: 42, guid: 'guid-1', infoHash: 'deadbeef', downloadUrl: 'http://x/1', indexerId: 3 }];
        (downloadService.getById as Mock).mockResolvedValue(hydratedDownload());
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', infoHash: 'deadbeef', indexerId: 3 });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(200);
        expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
        expect(downloadService.getById as Mock).toHaveBeenCalledWith(42);
      });

      it('(b) matches an info_hash-only torrent row by search-time infoHash (case-insensitive)', async () => {
        downloadRows = [{ id: 7, guid: null, infoHash: 'abcdef0123', downloadUrl: 'http://x/2', indexerId: 3 }];
        (downloadService.getById as Mock).mockResolvedValue(hydratedDownload({ id: 7 }));
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/other', title: 'T', protocol: 'torrent', infoHash: 'ABCDEF0123' });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(200);
        expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
        expect(downloadService.getById as Mock).toHaveBeenCalledWith(7);
      });

      it('(c) matches a downloadUrl-only fallback row by raw search-time downloadUrl', async () => {
        downloadRows = [{ id: 9, guid: null, infoHash: null, downloadUrl: 'http://x/3', indexerId: null }];
        (downloadService.getById as Mock).mockResolvedValue(hydratedDownload({ id: 9 }));
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/3', title: 'T', protocol: 'torrent' });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(200);
        expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
        expect(downloadService.getById as Mock).toHaveBeenCalledWith(9);
      });

      it('(d) documented degradation: adapter-rewritten stored URL with no stable identifier misses → fresh grab', async () => {
        // Stored row holds the EFFECTIVE (adapter-rewritten) URL; the search-time
        // token carries only the original URL and no guid/infoHash. This is the
        // accepted miss — and is unreachable for real results, which carry a guid.
        downloadRows = [{ id: 11, guid: null, infoHash: null, downloadUrl: 'http://x/rewritten', indexerId: null }];
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/original', title: 'T', protocol: 'torrent' });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(201);
        expect(downloadOrchestrator.grab as Mock).toHaveBeenCalledTimes(1);
      });

      it('guid precedence wins over a competing info_hash match when both identifiers are present', async () => {
        downloadRows = [
          { id: 1, guid: 'other', infoHash: 'xyz', downloadUrl: 'http://a', indexerId: 3 },
          { id: 2, guid: 'guid-1', infoHash: 'zzz', downloadUrl: 'http://b', indexerId: 3 },
        ];
        (downloadService.getById as Mock).mockResolvedValue(hydratedDownload({ id: 2 }));
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', infoHash: 'xyz', indexerId: 3 });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(200);
        // guid-first precedence selects row 2, NOT the infoHash-matching row 1.
        expect(downloadService.getById as Mock).toHaveBeenCalledWith(2);
      });

      it('(F1) a token carrying an indexerId does NOT match a same-guid row whose persisted indexerId is null → fresh grab', async () => {
        // Guid is scoped to indexerId when the token carries one: a persisted
        // null indexerId is NOT a wildcard, so dedup misses and a fresh grab runs.
        downloadRows = [{ id: 50, guid: 'guid-1', infoHash: null, downloadUrl: 'http://x/1', indexerId: null }];
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3 });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(201);
        expect(downloadOrchestrator.grab as Mock).toHaveBeenCalledTimes(1);
        expect(downloadService.getById as Mock).not.toHaveBeenCalled();
      });

      it('(F1) a token carrying an indexerId does NOT match a same-guid row from a DIFFERENT indexer → fresh grab', async () => {
        downloadRows = [{ id: 51, guid: 'guid-1', infoHash: null, downloadUrl: 'http://x/1', indexerId: 5 }];
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1', indexerId: 3 });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(201);
        expect(downloadOrchestrator.grab as Mock).toHaveBeenCalledTimes(1);
        expect(downloadService.getById as Mock).not.toHaveBeenCalled();
      });

      it('(F1) a token with NO indexerId still matches a same-guid row on guid alone', async () => {
        downloadRows = [{ id: 52, guid: 'guid-1', infoHash: null, downloadUrl: 'http://x/1', indexerId: 5 }];
        (downloadService.getById as Mock).mockResolvedValue(hydratedDownload({ id: 52 }));
        const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1' });

        const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });

        expect(res.statusCode).toBe(200);
        expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
        expect(downloadService.getById as Mock).toHaveBeenCalledWith(52);
      });
    });
  });

  // --------------------------------------------------------------------------
  // Grab — conflicts & errors
  // --------------------------------------------------------------------------

  describe('POST /api/v1/books/:publicId/grab — conflicts & errors', () => {
    const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-x' });
    const grab = (body: Record<string, unknown> = { releaseId }) =>
      app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: body });

    it('surfaces a DuplicateDownloadError for a different active release as a 409 v1 envelope (ACTIVE_DOWNLOAD_EXISTS)', async () => {
      (downloadOrchestrator.grab as Mock).mockRejectedValue(new DuplicateDownloadError('Book already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'));

      const res = await grab();

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expectV1Envelope(body);
      expect(body.error.code).toBe('ACTIVE_DOWNLOAD_EXISTS');
    });

    it.each([
      ['auth', new DownloadClientAuthError('qbittorrent'), 401],
      ['error', new DownloadClientError('qbittorrent'), 502],
      ['timeout', new DownloadClientTimeoutError('qbittorrent'), 504],
    ])('maps DownloadClientError(%s) to a %s v1 envelope with no leak', async (_label, error, status) => {
      (downloadOrchestrator.grab as Mock).mockRejectedValue(error);

      const res = await grab();

      expect(res.statusCode).toBe(status);
      const body = res.json();
      expectV1Envelope(body);
      expect(JSON.stringify(body)).not.toContain('qbittorrent');
    });

    it('maps a generic grab error to a 500 v1 envelope (INTERNAL_ERROR) with no raw message leak', async () => {
      (downloadOrchestrator.grab as Mock).mockRejectedValue(new Error('secret http://internal/path failure'));

      const res = await grab();

      expect(res.statusCode).toBe(500);
      const body = res.json();
      expectV1Envelope(body);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(body)).not.toContain('internal/path');
    });

    it('rejects an undecodable releaseId with a 400 v1 envelope', async () => {
      const res = await grab({ releaseId: 'not-a-valid-token!!!' });

      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
      expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
    });

    it('rejects unknown/extra body keys with a 400 v1 envelope (strict)', async () => {
      const res = await grab({ releaseId, extra: 'nope' });

      expect(res.statusCode).toBe(400);
      expectV1Envelope(res.json());
    });

    it('returns a 404 v1 envelope for an unknown publicId', async () => {
      bookRows = [];

      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_nope/grab', headers: keyHeaders, payload: { releaseId } });

      expect(res.statusCode).toBe(404);
      expectV1Envelope(res.json());
      expect(downloadOrchestrator.grab as Mock).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Auth (real auth-plugin fixture)
  // --------------------------------------------------------------------------

  describe('auth (real auth-plugin fixture)', () => {
    const releaseId = encodeReleaseId({ downloadUrl: 'http://x/1', title: 'T', protocol: 'torrent', guid: 'guid-1' });

    it('rejects a missing API key with 401 (status only — ambient body, not the v1 envelope)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an invalid API key with the 401 v1 envelope', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const res = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search', headers: { 'x-api-key': 'wrong' } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
    });

    it('accepts a valid API key (search 200, grab 201)', async () => {
      const search = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/search', headers: keyHeaders });
      expect(search.statusCode).toBe(200);

      const grabRes = await app.inject({ method: 'POST', url: '/api/v1/books/bk_test000000000000000/grab', headers: keyHeaders, payload: { releaseId } });
      expect(grabRes.statusCode).toBe(201);
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
