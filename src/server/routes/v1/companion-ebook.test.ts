import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cookie from '@fastify/cookie';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import authPlugin from '../../plugins/auth.js';
import type { AuthService } from '../../services/auth.service.js';
import type { Db } from '@db/index.js';
import { createMockDb, mockDbChain, installMockAppLog, inject } from '../../__tests__/helpers.js';
import { createMockSettings } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import type { CompanionEbookRow } from '../../services/types.js';
import { openCompanionEbook } from '../../services/companion-ebook-open.js';
import { v1CompanionEbookRoutes, MAX_CONCURRENT_COMPANION_STREAMS } from './companion-ebook.js';

// Keep the production auth plugin active.
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

// Spy on real filesystem opens so "no handle was opened" remains assertable.
vi.mock('../../services/companion-ebook-open.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/companion-ebook-open.js')>(
    '../../services/companion-ebook-open.js',
  );
  return { ...actual, openCompanionEbook: vi.fn(actual.openCompanionEbook) };
});

const BOOK_ID = 11;
const PUBLIC_ID = 'bk_kQ8vT2nS';
const EPUB = 'The Book, Volume 1 — édition.epub';
const EPUB_BYTES = 'PK pretend epub payload';
const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

const DISABLED = { error: { code: 'companion_epub_disabled', message: 'Companion ebooks are disabled' } };
const UNAVAILABLE = { error: { code: 'companion_epub_unavailable', message: 'Companion ebook is unavailable' } };
const BUSY = { error: { code: 'companion_epub_busy', message: 'Too many concurrent companion ebook downloads' } };

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, so concurrency tests never race on a fixed sleep. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Separator-normalised, so a path comparison behaves the same on Windows and Linux. */
const posix = (value: string) => value.split('\\').join('/');

describe('v1 companion ebook stream', () => {
  let apps: FastifyInstance[];
  let bookService: { getById: Mock };
  let settingsService: { get: Mock };
  /** `reconcileAll` is an extra runtime probe proving this per-book opener never sweeps. */
  let companionReconciler: { reconcileBook: Mock; reconcileAll: Mock };
  let db: ReturnType<typeof createMockDb>;
  let libraryRoot: string;
  let bookPath: string;
  let realOpen: typeof openCompanionEbook;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../services/companion-ebook-open.js')>(
      '../../services/companion-ebook-open.js',
    );
    realOpen = actual.openCompanionEbook;
  });

  beforeEach(async () => {
    // `mockClear` does not drain queued `mockImplementationOnce` entries.
    vi.mocked(openCompanionEbook).mockReset();
    vi.mocked(openCompanionEbook).mockImplementation((input, log) => realOpen(input, log));
    (authService.validateApiKey as Mock).mockResolvedValue(true);

    apps = [];
    libraryRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1975-route-')));
    bookPath = join(libraryRoot, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });

    bookService = { getById: vi.fn() };
    settingsService = { get: vi.fn() };
    companionReconciler = {
      reconcileBook: vi.fn().mockResolvedValue(undefined),
      reconcileAll: vi.fn().mockResolvedValue(undefined),
    };
    db = createMockDb();

    setSettings({ enabled: true });
    setBook({});
    setDb({ rowid: BOOK_ID, observation: row() });
  });

  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    rmSync(libraryRoot, { recursive: true, force: true });
  });

  function row(overrides: Partial<CompanionEbookRow> = {}): CompanionEbookRow {
    return {
      bookId: BOOK_ID,
      status: 'available',
      filename: EPUB,
      sizeBytes: Buffer.byteLength(EPUB_BYTES),
      mtimeMs: 1_700_000_000_000,
      ctimeMs: 1_700_000_000_000,
      validationCode: null,
      candidateCount: 1,
      selectedFilename: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    } as CompanionEbookRow;
  }

  function setSettings(opts: { enabled: boolean; root?: string }) {
    const settings = createMockSettings({
      companionEpub: { enabled: opts.enabled },
      library: { path: opts.root ?? libraryRoot },
    });
    settingsService.get.mockImplementation((category: keyof typeof settings) =>
      Promise.resolve(settings[category]),
    );
  }

  function setBook(overrides: Record<string, unknown> | null) {
    bookService.getById.mockResolvedValue(
      overrides === null ? null : { id: BOOK_ID, status: 'imported', path: bookPath, title: 'Title', ...overrides },
    );
  }

  /** Discriminate lookups by projection instead of fragile call order. */
  function setDb(opts: { rowid: number | null; observation: CompanionEbookRow | null }) {
    db.select.mockImplementation((projection?: unknown) =>
      projection === undefined
        ? mockDbChain(opts.observation ? [opts.observation] : [])
        : mockDbChain(opts.rowid === null ? [] : [{ id: opts.rowid }]),
    );
  }

  async function writeEpub(name = EPUB, bytes = EPUB_BYTES) {
    await writeFile(join(bookPath, name), bytes);
  }

  async function makeApp(maxConcurrentStreams?: number): Promise<FastifyInstance> {
    const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } })
      .withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    // Register production auth so this exact path cannot become public unnoticed.
    await app.register(authPlugin, { authService });
    await v1CompanionEbookRoutes(app, {
      bookService: bookService as never,
      settingsService: settingsService as never,
      reconciler: companionReconciler,
      ...(maxConcurrentStreams !== undefined && { maxConcurrentStreams }),
    }, inject<Db>(db));
    await app.ready();
    apps.push(app);
    return app;
  }

  function download(app: FastifyInstance, publicId = PUBLIC_ID) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/books/${publicId}/companion-epub`,
      headers: keyHeaders,
    });
  }

  function expectNoPathLeak(payload: string) {
    const body = posix(payload);
    expect(body).not.toContain(posix(libraryRoot));
    expect(body).not.toContain(posix(bookPath));
    expect(body).not.toContain(EPUB);
  }

  describe('gate order and status mapping', () => {
    it('returns 409 with the exact disabled body and performs NO book-existence read', async () => {
      setSettings({ enabled: false });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(DISABLED);
      expectNoPathLeak(res.payload);
      expect(db.select).not.toHaveBeenCalled();
      expect(bookService.getById).not.toHaveBeenCalled();
    });

    it.each(['%20', '%20%20', '%09', '%20%09%0A'])(
      'returns the v1 400 BAD_REQUEST envelope for the whitespace-only publicId %s',
      async (encoded) => {
        const app = await makeApp();

        const res = await download(app, encoded);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: expect.any(String) } });
        expect(db.select).not.toHaveBeenCalled();
        expect(bookService.getById).not.toHaveBeenCalled();
        expect(vi.mocked(openCompanionEbook)).not.toHaveBeenCalled();
      },
    );

    it('returns the companion 404 — never { code: NOT_FOUND } — for an unresolvable publicId', async () => {
      setDb({ rowid: null, observation: null });
      const app = await makeApp();

      const res = await download(app, 'bk_does_not_exist');

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
      expect(bookService.getById).not.toHaveBeenCalled();
    });

    it('returns the companion 404 when the publicId resolves but the book row is gone', async () => {
      setBook(null);
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
      expect(bookService.getById).toHaveBeenCalledWith(BOOK_ID);
    });

    it('returns 404 when books.status is not imported, even with an available row and an intact path', async () => {
      await writeEpub();
      setBook({ status: 'missing' });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
    });

    it.each(['none', 'ambiguous', 'invalid', 'drm_protected'] as const)(
      'returns 404 for a %s observation',
      async (status) => {
        await writeEpub();
        setDb({ rowid: BOOK_ID, observation: row({ status }) });
        const app = await makeApp();

        const res = await download(app);

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(UNAVAILABLE);
      },
    );

    it('returns 404 when there is no observation row at all', async () => {
      await writeEpub();
      setDb({ rowid: BOOK_ID, observation: null });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
    });

    it('returns 404 when an available row carries a null filename', async () => {
      await writeEpub();
      setDb({ rowid: BOOK_ID, observation: row({ filename: null }) });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
      expect(vi.mocked(openCompanionEbook)).not.toHaveBeenCalled();
    });

    it.each([null, '', '   '])('returns 404 for a blank books.path (%j)', async (path) => {
      await writeEpub();
      setBook({ path });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
      expect(vi.mocked(openCompanionEbook)).not.toHaveBeenCalled();
    });

    it.each(['invalid_filename', 'not_regular_file', 'outside_library', 'missing', 'unreadable'] as const)(
      'returns 404 with a { bookId, outcome } warn for the %s open outcome',
      async (outcome) => {
        vi.mocked(openCompanionEbook).mockResolvedValue({ outcome });
        const app = await makeApp();
        const mockLog = installMockAppLog(app);

        const res = await download(app);

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(UNAVAILABLE);
        expectNoPathLeak(res.payload);
        // Default-level API logs may contain only this path-free boundary record.
        const boundary = mockLog.spies.warn.mock.calls.map((call) => call[0]);
        expect(boundary).toContainEqual({ bookId: BOOK_ID, outcome });
        mockLog.restore();
      },
    );

    it.each(['invalid_filename', 'not_regular_file', 'outside_library', 'missing', 'unreadable'] as const)(
      'AC26: the %s outcome enqueues exactly one reconcileBook, with the 404 body unchanged',
      async (outcome) => {
        vi.mocked(openCompanionEbook).mockResolvedValue({ outcome });
        const app = await makeApp();

        const res = await download(app);

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(UNAVAILABLE);
        expect(companionReconciler.reconcileBook).toHaveBeenCalledTimes(1);
        expect(companionReconciler.reconcileBook).toHaveBeenCalledWith(BOOK_ID);
        expect(companionReconciler.reconcileAll).not.toHaveBeenCalled();
      },
    );

    it('AC26: a successful stream enqueues ZERO reconciles', async () => {
      await writeEpub();
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(200);
      expect(companionReconciler.reconcileBook).not.toHaveBeenCalled();
    });

    it('AC26: the pre-opener negatives (disabled, unknown book, not exposed) enqueue ZERO reconciles', async () => {
      setSettings({ enabled: false });
      const app = await makeApp();

      expect((await download(app)).statusCode).toBe(409);
      expect(companionReconciler.reconcileBook).not.toHaveBeenCalled();
    });

    it('AC28: a REJECTING reconciler changes neither the status code nor the body', async () => {
      companionReconciler.reconcileBook.mockRejectedValue(new Error('reconcile rejected'));
      vi.mocked(openCompanionEbook).mockResolvedValue({ outcome: 'missing' });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
    });

    it('AC28: a SYNCHRONOUSLY THROWING reconciler changes neither the status code nor the body', async () => {
      companionReconciler.reconcileBook.mockImplementation(() => { throw new Error('reconcile threw synchronously'); });
      vi.mocked(openCompanionEbook).mockResolvedValue({ outcome: 'missing' });
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(UNAVAILABLE);
    });

    it('AC31: two consecutive mismatched requests enqueue TWICE — serialization is not coalescing', async () => {
      vi.mocked(openCompanionEbook).mockResolvedValue({ outcome: 'outside_library' });
      const app = await makeApp();

      expect((await download(app)).statusCode).toBe(404);
      expect((await download(app)).statusCode).toBe(404);

      expect(companionReconciler.reconcileBook).toHaveBeenCalledTimes(2);
    });
  });

  describe('the 200 response', () => {
    it('streams the file with the documented headers and body', async () => {
      await writeEpub();
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/epub+zip');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload.toString()).toBe(EPUB_BYTES);
    });

    it('sanitises the attachment filename so it cannot break out of the quoted value', async () => {
      await writeEpub();
      const app = await makeApp();

      const res = await download(app);

      // Every non-ASCII/unsafe filename character collapses independently.
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="The-Book--Volume-1----dition.epub"',
      );
      expect(res.headers['content-disposition']).not.toContain('"; ');
    });

    describe('Content-Length comes from fstat, never companion_ebooks.size_bytes', () => {
      it('when the real file is LARGER than the stored size', async () => {
        const bytes = `${EPUB_BYTES} plus a great deal more content than was ever observed`;
        await writeEpub(EPUB, bytes);
        setDb({ rowid: BOOK_ID, observation: row({ sizeBytes: 3 }) });
        const app = await makeApp();

        const res = await download(app);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
        expect(res.headers['content-length']).not.toBe('3');
        expect(res.rawPayload.length).toBe(Buffer.byteLength(bytes));
      });

      it('when the real file is SMALLER than the stored size', async () => {
        const bytes = 'tiny';
        await writeEpub(EPUB, bytes);
        setDb({ rowid: BOOK_ID, observation: row({ sizeBytes: 9_999_999 }) });
        const app = await makeApp();

        const res = await download(app);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-length']).toBe(String(Buffer.byteLength(bytes)));
        expect(res.headers['content-length']).not.toBe('9999999');
        expect(res.rawPayload.length).toBe(Buffer.byteLength(bytes));
      });
    });
  });

  describe('a settings rejection', () => {
    it('propagates a companionEpub read failure to the v1 500 envelope', async () => {
      settingsService.get.mockRejectedValue(new Error('settings table is gone'));
      const app = await makeApp();

      const res = await download(app);

      // Unlike capabilities, a file route has no degraded response.
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      expect(res.payload).not.toContain('settings table is gone');
    });

    it('propagates a library read failure to a 500 WITHOUT stranding the semaphore slot', async () => {
      await writeEpub();
      const good = createMockSettings({
        companionEpub: { enabled: true },
        library: { path: libraryRoot },
      });
      settingsService.get.mockImplementation((category: 'companionEpub' | 'library') =>
        category === 'library'
          ? Promise.reject(new Error('library settings unreadable'))
          : Promise.resolve(good[category]),
      );
      const app = await makeApp(1);

      const failed = await download(app);
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });

      // Library settings are read before acquire; otherwise this rejection would leak the only slot.
      setSettings({ enabled: true });
      const next = await download(app);
      expect(next.statusCode).toBe(200);
      expect(next.rawPayload.toString()).toBe(EPUB_BYTES);
    });
  });

  describe('bounded concurrency', () => {
    /** Gate opens inside the acquired window; `gatedCalls` lets another app run through. */
    function gateOpen(gatedCalls = Number.POSITIVE_INFINITY): { open: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = 0;
      vi.mocked(openCompanionEbook).mockImplementation(async (input, log) => {
        if (held < gatedCalls) {
          held++;
          await gate;
        }
        return realOpen(input, log);
      });
      return { open: () => release() };
    }

    it('returns the exact 503 body while the only slot is in flight, and the first request still completes', async () => {
      await writeEpub();
      const app = await makeApp(1);
      const { open } = gateOpen();

      const first = download(app);
      await waitUntil(() => vi.mocked(openCompanionEbook).mock.calls.length === 1, 'the first open');

      const saturated = await download(app);
      expect(saturated.statusCode).toBe(503);
      expect(saturated.json()).toEqual(BUSY);
      expectNoPathLeak(saturated.payload);
      expect(vi.mocked(openCompanionEbook)).toHaveBeenCalledTimes(1);

      open();
      const firstRes = await first;
      expect(firstRes.statusCode).toBe(200);
      expect(firstRes.rawPayload.toString()).toBe(EPUB_BYTES);
    });

    it('returns the slot after the stream ends, so a later request succeeds', async () => {
      await writeEpub();
      const app = await makeApp(1);

      expect((await download(app)).statusCode).toBe(200);
      await wait(20);
      const second = await download(app);

      expect(second.statusCode).toBe(200);
      expect(second.rawPayload.toString()).toBe(EPUB_BYTES);
    });

    it('returns the slot on the 404 path — two sequential 404s still leave room for a 200', async () => {
      const app = await makeApp(1);

      expect((await download(app)).statusCode).toBe(404);
      expect((await download(app)).statusCode).toBe(404);

      await writeEpub();
      const third = await download(app);
      expect(third.statusCode).toBe(200);
      expect(third.rawPayload.toString()).toBe(EPUB_BYTES);
    });

    it(`defaults to MAX_CONCURRENT_COMPANION_STREAMS (${MAX_CONCURRENT_COMPANION_STREAMS}) when the seam is omitted`, async () => {
      await writeEpub();
      const app = await makeApp();
      const { open } = gateOpen();

      const inflight = Array.from({ length: MAX_CONCURRENT_COMPANION_STREAMS }, () => download(app));
      await waitUntil(
        () => vi.mocked(openCompanionEbook).mock.calls.length === MAX_CONCURRENT_COMPANION_STREAMS,
        'every default slot to be taken',
      );

      const saturated = await download(app);
      expect(saturated.statusCode).toBe(503);
      expect(saturated.json()).toEqual(BUSY);
      expect(vi.mocked(openCompanionEbook)).toHaveBeenCalledTimes(MAX_CONCURRENT_COMPANION_STREAMS);

      open();
      for (const res of await Promise.all(inflight)) expect(res.statusCode).toBe(200);
    });

    it('does not share saturation state between two separately-created apps', async () => {
      await writeEpub();
      const saturatedApp = await makeApp(1);
      const freshApp = await makeApp(1);
      // Gate only the held request; the fresh app must run through.
      const { open } = gateOpen(1);

      const held = download(saturatedApp);
      await waitUntil(() => vi.mocked(openCompanionEbook).mock.calls.length === 1, 'the held open');

      expect((await download(saturatedApp)).statusCode).toBe(503);
      const other = await download(freshApp);
      expect(other.statusCode).toBe(200);
      expect(other.rawPayload.toString()).toBe(EPUB_BYTES);

      open();
      expect((await held).statusCode).toBe(200);
    });

    it.each([
      ['zero', 0],
      ['a negative', -3],
      ['a fraction below one', 0.5],
      ['NaN', Number.NaN],
    ])('clamps %s stream limit to a usable capacity rather than a dead endpoint', async (_label, supplied) => {
      await writeEpub();
      const app = await makeApp(supplied);

      const res = await download(app);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.toString()).toBe(EPUB_BYTES);
    });

    it('truncates a fractional limit rather than admitting an extra stream', async () => {
      await writeEpub();
      const app = await makeApp(1.9);
      const { open } = gateOpen();

      const first = download(app);
      await waitUntil(() => vi.mocked(openCompanionEbook).mock.calls.length === 1, 'the first open');

      expect((await download(app)).statusCode).toBe(503);

      open();
      expect((await first).statusCode).toBe(200);
    });
  });

  describe('ambient API-key auth', () => {
    it('rejects an invalid key with the native-v1 401 envelope', async () => {
      (authService.validateApiKey as Mock).mockResolvedValue(false);
      const app = await makeApp();

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/books/${PUBLIC_ID}/companion-epub`,
        headers: { 'x-api-key': 'bad-key' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'INVALID_API_KEY', message: 'Invalid API key' } });
    });

    it('rejects a request with no credentials at all', async () => {
      const app = await makeApp();

      // A generic auth suite would not catch this exact path becoming public.
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/books/${PUBLIC_ID}/companion-epub`,
      });

      expect(res.statusCode).toBe(401);
      expect(bookService.getById).not.toHaveBeenCalled();
    });

    it('lets a valid key reach the route', async () => {
      await writeEpub();
      const app = await makeApp();

      const res = await download(app);

      expect(res.statusCode).toBe(200);
      expect(authService.validateApiKey as Mock).toHaveBeenCalledWith(VALID_KEY);
    });
  });
});
