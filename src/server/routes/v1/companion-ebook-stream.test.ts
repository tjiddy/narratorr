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
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FileHandle } from 'node:fs/promises';
import authPlugin from '../../plugins/auth.js';
import type { AuthService } from '../../services/auth.service.js';
import type { Db } from '@db/index.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { createMockSettings } from '@shared/schemas/settings/create-mock-settings.fixtures.js';
import type { CompanionEbookRow } from '../../services/types.js';
import { openCompanionEbook } from '../../services/companion-ebook-open.js';
import { v1CompanionEbookRoutes } from './companion-ebook.js';

/**
 * Real-socket coverage: `app.inject()` cannot exercise disconnect or teardown.
 * This makes handle closure, committed-response behavior, and semaphore release observable.
 */

vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

vi.mock('../../services/companion-ebook-open.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/companion-ebook-open.js')>(
    '../../services/companion-ebook-open.js',
  );
  return { ...actual, openCompanionEbook: vi.fn(actual.openCompanionEbook) };
});

const BOOK_ID = 11;
const PUBLIC_ID = 'bk_kQ8vT2nS';
const EPUB = 'big.epub';
/** Large enough that the response is still in flight when the client aborts. */
const PAYLOAD = Buffer.alloc(8 * 1024 * 1024, 'x');
const keyHeaders = { 'x-api-key': 'valid-key' };

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

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface RawResponse {
  status?: number;
  contentLength?: string;
  acceptRanges?: string;
  headers: http.IncomingHttpHeaders;
  length: number;
  tail: string;
  terminated: boolean;
}

interface GetOptions {
  onFirstChunk?: (request: http.ClientRequest) => void;
  headers?: http.OutgoingHttpHeaders;
}

function get(url: string, options: GetOptions = {}): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const { onFirstChunk, headers: extraHeaders } = options;
    const request = http.get(url, { headers: { ...keyHeaders, ...extraHeaders } }, (response) => {
      const finish = (terminated: boolean) => {
        const body = Buffer.concat(chunks);
        resolve({
          ...(response.statusCode !== undefined && { status: response.statusCode }),
          ...(typeof response.headers['content-length'] === 'string' && {
            contentLength: response.headers['content-length'],
          }),
          ...(typeof response.headers['accept-ranges'] === 'string' && {
            acceptRanges: response.headers['accept-ranges'],
          }),
          headers: response.headers,
          length: body.length,
          tail: body.subarray(-400).toString('utf8'),
          terminated,
        });
      };
      let first = true;
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (first) {
          first = false;
          onFirstChunk?.(request);
        }
      });
      response.on('aborted', () => finish(true));
      response.on('error', () => finish(true));
      response.on('end', () => finish(false));
    });
    request.on('error', () => resolve({ headers: {}, length: 0, tail: '', terminated: true }));
    setTimeout(() => reject(new Error('request never settled')), 15_000);
  });
}

describe('v1 companion ebook stream — real socket', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;
  let libraryRoot: string;
  let bookPath: string;
  let baseUrl: string;
  let closeSpy: Mock;
  let handles: FileHandle[];
  let realOpen: typeof openCompanionEbook;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../services/companion-ebook-open.js')>(
      '../../services/companion-ebook-open.js',
    );
    realOpen = actual.openCompanionEbook;
  });

  beforeEach(async () => {
    // `mockReset` drains the `*Once()` queues these tests use (`vitest-clearallmocks-once-queue`).
    vi.mocked(openCompanionEbook).mockReset();
    vi.mocked(openCompanionEbook).mockImplementation((input, log) => realOpen(input, log));
    closeSpy = vi.fn();
    handles = [];

    libraryRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1975-sock-')));
    bookPath = join(libraryRoot, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, EPUB), PAYLOAD);

    const settings = createMockSettings({
      companionEpub: { enabled: true },
      library: { path: libraryRoot },
    });
    const settingsService = {
      get: vi.fn((category: 'companionEpub' | 'library') => Promise.resolve(settings[category])),
    };
    const bookService = {
      getById: vi.fn().mockResolvedValue({ id: BOOK_ID, status: 'imported', path: bookPath, title: 'Title' }),
    };

    const companionReconciler = { reconcileBook: vi.fn().mockResolvedValue(undefined) };

    db = createMockDb();
    const row = {
      bookId: BOOK_ID, status: 'available', filename: EPUB, sizeBytes: PAYLOAD.length,
      mtimeMs: 1, ctimeMs: 1, validationCode: null, candidateCount: 1, selectedFilename: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    } as CompanionEbookRow;
    db.select.mockImplementation((projection?: unknown) =>
      projection === undefined ? mockDbChain([row]) : mockDbChain([{ id: BOOK_ID }]),
    );

    app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } })
      .withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    await app.register(authPlugin, { authService });
    // A limit of one exposes leaks as 503s and double releases as concurrent 200s.
    await v1CompanionEbookRoutes(app, {
      bookService: bookService as never,
      settingsService: settingsService as never,
      reconciler: companionReconciler,
      maxConcurrentStreams: 1,
    }, inject<Db>(db));
    await app.ready();

    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1/books/${PUBLIC_ID}/companion-epub`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(libraryRoot, { recursive: true, force: true });
  });

  function spyOnHandle(options?: { failAfterFirstChunk: boolean }) {
    vi.mocked(openCompanionEbook).mockImplementationOnce(async (input, log) => {
      const result = await realOpen(input, log);
      if (result.outcome !== 'ok') return result;
      handles.push(result.handle);

      const originalClose = result.handle.close.bind(result.handle);
      result.handle.close = async () => { closeSpy(); return originalClose(); };

      if (options?.failAfterFirstChunk) {
        const originalCreate = result.handle.createReadStream.bind(result.handle);
        result.handle.createReadStream = (streamOptions) => {
          const stream = originalCreate(streamOptions);
          stream.once('data', () => {
            setImmediate(() => stream.emit('error', Object.assign(new Error('EIO: read failed'), { code: 'EIO' })));
          });
          return stream;
        };
      }
      return result;
    });
  }

  function gateOpen(gatedCalls = 1): { open: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = 0;
    vi.mocked(openCompanionEbook).mockImplementation(async (input, log) => {
      if (held < gatedCalls) { held++; await gate; }
      return realOpen(input, log);
    });
    return { open: () => release() };
  }

  /** Prove capacity is neither leaked nor double-released; the semaphore decrement has no floor. */
  async function expectCapacityIsExactlyOne() {
    const calls = () => vi.mocked(openCompanionEbook).mock.calls.length;
    const before = calls();
    const { open } = gateOpen(1);

    const held = get(baseUrl);
    await waitUntil(() => calls() > before, 'the replacement stream to acquire the slot');

    const busy = await get(baseUrl);
    expect(busy.status).toBe(503);
    expect(JSON.parse(busy.tail)).toEqual(BUSY);

    open();
    const heldResult = await held;
    expect(heldResult.status).toBe(200);
    expect(heldResult.length).toBe(PAYLOAD.length);
  }

  it('closes the handle exactly once on the success path and returns the slot', async () => {
    spyOnHandle();

    const res = await get(baseUrl);

    expect(res.status).toBe(200);
    expect(res.length).toBe(PAYLOAD.length);
    await wait(150);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(handles[0]!.fd).toBe(-1);

    await expectCapacityIsExactlyOne();
  });

  it('closes the handle exactly once when the client aborts mid-stream, and returns the slot', async () => {
    spyOnHandle();

    const res = await get(baseUrl, { onFirstChunk: (request) => request.destroy() });

    expect(res.terminated).toBe(true);
    expect(res.length).toBeLessThan(PAYLOAD.length);
    await wait(150);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(handles[0]!.fd).toBe(-1);

    await expectCapacityIsExactlyOne();
  });

  it('terminates the connection on a post-headers read failure instead of appending an error body', async () => {
    spyOnHandle({ failAfterFirstChunk: true });

    const res = await get(baseUrl);

    // Termination plus Content-Length exposes a truncated EPUB instead of accepting it as whole.
    expect(res.terminated).toBe(true);
    expect(res.contentLength).toBe(String(PAYLOAD.length));
    expect(res.length).toBeLessThan(PAYLOAD.length);
    // Inspect received bytes; handler execution cannot prove the committed body stayed clean.
    expect(res.tail).not.toContain('"error"');
    expect(res.tail).not.toContain('companion_epub');

    await wait(150);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(handles[0]!.fd).toBe(-1);
  });

  it('restores exactly one slot after a mid-stream read failure', async () => {
    spyOnHandle({ failAfterFirstChunk: true });

    const failed = await get(baseUrl);
    expect(failed.terminated).toBe(true);
    await wait(150);

    // Stream `error` and response `close` can both fire; release must remain idempotent.
    await expectCapacityIsExactlyOne();
  });

  it('returns the slot when the client disconnects BEFORE the stream starts (open still in flight)', async () => {
    // Acquire precedes the awaited open. Registering `close` only inside the later stream helper
    // misses an in-flight disconnect and permanently leaks the sole slot.
    const calls = () => vi.mocked(openCompanionEbook).mock.calls.length;
    const before = calls();
    const { open } = gateOpen(1);

    // `get()` aborts on the first chunk; this disconnect must land while open is still gated.
    const aborted = http.get(baseUrl, { headers: keyHeaders }, () => undefined);
    aborted.on('error', () => undefined);

    await waitUntil(() => calls() > before, 'the gated open to acquire the slot');
    aborted.destroy();
    open();
    await wait(150);

    const after = await get(baseUrl);
    expect(after.status).toBe(200);
    expect(after.length).toBe(PAYLOAD.length);
  });

  /**
   * #2026 row 14: range support is absent, so return the whole body under 200 with no range headers.
   * Compare received bytes with Content-Length to reject a partial body presented as whole.
   */
  it('ignores a Range header and returns the complete body under a plain 200', async () => {
    const res = await get(baseUrl, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(206);
    expect(res.contentLength).toBe(String(PAYLOAD.length));
    expect(res.length).toBe(PAYLOAD.length);
    expect(res.terminated).toBe(false);
    expect(res.acceptRanges).toBeUndefined();
    expect(res.headers).not.toHaveProperty('content-range');
  });
});
