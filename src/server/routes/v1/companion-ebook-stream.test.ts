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
import type { Db } from '../../../db/index.js';
import { createMockDb, mockDbChain, inject } from '../../__tests__/helpers.js';
import { createMockSettings } from '../../../shared/schemas/settings/create-mock-settings.fixtures.js';
import type { CompanionEbookRow } from '../../services/types.js';
import { openCompanionEbook } from '../../services/companion-ebook-open.js';
import { v1CompanionEbookRoutes } from './companion-ebook.js';

/**
 * Stream lifecycle for the PUBLIC v1 route, driven through a REAL bound port rather than
 * `app.inject()`. Per `sse-inject-helper-gap`, injection cannot exercise a client disconnect
 * or socket teardown, and every property under test here — exactly-once handle close, no
 * `{"error":…}` body appended to an already-committed `200`, and the semaphore slot coming
 * back after each teardown path — is invisible to it.
 * `src/server/routes/companion-ebook-stream.test.ts` is the in-repo pattern this copies.
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
  length: number;
  tail: string;
  terminated: boolean;
}

/** One real HTTP GET, resolved with whatever the client actually received. */
function get(url: string, onFirstChunk?: (request: http.ClientRequest) => void): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const request = http.get(url, { headers: keyHeaders }, (response) => {
      const finish = (terminated: boolean) => {
        const body = Buffer.concat(chunks);
        resolve({
          ...(response.statusCode !== undefined && { status: response.statusCode }),
          ...(typeof response.headers['content-length'] === 'string' && {
            contentLength: response.headers['content-length'],
          }),
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
    request.on('error', () => resolve({ length: 0, tail: '', terminated: true }));
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

    const companionReconciler = {
      reconcileBook: vi.fn().mockResolvedValue(undefined),
      reconcileAll: vi.fn().mockResolvedValue(undefined),
    };

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
    // Limit 1 throughout: it makes "the slot came back" observable as a 200 rather than a 503,
    // and "exactly one slot came back" observable as a concurrent 503.
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

  /** Wrap the real handle so `close()` calls are countable, optionally corrupting the stream. */
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

  /** Hold the next `gatedCalls` opens so a slot stays occupied deterministically. */
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

  /**
   * Capacity is EXACTLY one slot — not zero (a leaked acquire) and not two (a double release,
   * which `Semaphore.release()`'s floorless decrement would make permanent). One held stream
   * must succeed while a concurrent second is refused with the exact 503 body.
   */
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

    const res = await get(baseUrl, (request) => request.destroy()); // real client disconnect

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

    // The connection is cut and the promised length was never delivered, so the client can
    // tell the body is incomplete rather than accepting a truncated EPUB as a whole one.
    expect(res.terminated).toBe(true);
    expect(res.contentLength).toBe(String(PAYLOAD.length));
    expect(res.length).toBeLessThan(PAYLOAD.length);
    // Asserted on the RECEIVED BYTES, not on whether a handler ran: no JSON envelope was
    // appended under the already-committed 200.
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

    // A stream error can fire BOTH the stream `error` and the response `close` signal; the
    // idempotent releaser is what keeps that from raising the effective cap for the process.
    await expectCapacityIsExactlyOne();
  });
});
