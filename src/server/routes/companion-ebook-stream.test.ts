import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createTestApp,
  createMockServices,
  createMockDb,
  mockDbChain,
  installMockAppLog,
  inject,
} from '../__tests__/helpers.js';
import { createMockSettings } from '../../shared/schemas/settings/create-mock-settings.fixtures.js';
import type { Db } from '../../db/index.js';
import type { Services } from './index.js';
import type { CompanionEbookRow } from '../services/types.js';
import { openCompanionEbook } from '../services/companion-ebook-open.js';

/**
 * Client abort and the post-headers stream error are driven through a REAL bound server, not
 * `app.inject`: injection does not exercise a client disconnect or socket teardown, and both
 * properties under test here (exactly-once handle close, no `{ "error": … }` body appended to
 * an already-committed `200`) are invisible to it. The repository already supplements
 * injection this way for stream behaviour (`search-stream-filtering.test.ts`).
 */
vi.mock('../services/companion-ebook-open.js', async () => {
  const actual = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
    '../services/companion-ebook-open.js',
  );
  return { ...actual, openCompanionEbook: vi.fn(actual.openCompanionEbook) };
});

const BOOK_ID = 11;
const EPUB = 'big.epub';
/** Large enough that the response is still in flight when the client aborts. */
const PAYLOAD = Buffer.alloc(8 * 1024 * 1024, 'x');

describe('companion ebook download — real socket', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  let libraryRoot: string;
  let bookPath: string;
  let baseUrl: string;
  let closeSpy: Mock;

  beforeEach(async () => {
    vi.mocked(openCompanionEbook).mockClear();
    closeSpy = vi.fn();

    libraryRoot = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-sock-')));
    bookPath = join(libraryRoot, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, EPUB), PAYLOAD);

    services = createMockServices();
    const settings = createMockSettings({
      companionEpub: { enabled: true },
      library: { path: libraryRoot },
    });
    (services.settings.get as Mock).mockImplementation((category: keyof typeof settings) =>
      Promise.resolve(settings[category]),
    );
    (services.book.getById as Mock).mockResolvedValue({
      id: BOOK_ID, status: 'imported', path: bookPath, title: 'Title',
    });

    const db = createMockDb();
    const row = {
      bookId: BOOK_ID, status: 'available', filename: EPUB, sizeBytes: PAYLOAD.length,
      mtimeMs: 1, ctimeMs: 1, validationCode: null, candidateCount: 1, selectedFilename: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    } as CompanionEbookRow;
    db.select.mockReturnValue(mockDbChain([row]));

    app = await createTestApp(services, inject<Db>(db));
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(libraryRoot, { recursive: true, force: true });
  });

  /** Wrap the real handle so `close()` calls are countable, optionally corrupting the stream. */
  function spyOnHandle(options?: { failAfterFirstChunk: boolean }) {
    vi.mocked(openCompanionEbook).mockImplementationOnce(async (input, log) => {
      const actual = await vi.importActual<typeof import('../services/companion-ebook-open.js')>(
        '../services/companion-ebook-open.js',
      );
      const result = await actual.openCompanionEbook(input, log);
      if (result.outcome !== 'ok') return result;

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

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('closes the handle exactly once when the client aborts mid-stream', async () => {
    spyOnHandle();

    const aborted = await new Promise<boolean>((resolve, reject) => {
      const request = http.get(`${baseUrl}/api/books/${BOOK_ID}/companion-epub`, (response) => {
        expect(response.statusCode).toBe(200);
        response.once('data', () => {
          request.destroy(); // real client disconnect, not a cancelled promise
          resolve(true);
        });
      });
      request.on('error', () => resolve(true));
      setTimeout(() => reject(new Error('response never started')), 5000);
    });

    expect(aborted).toBe(true);
    await wait(150);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('terminates the connection on a post-headers stream error instead of appending an error body', async () => {
    spyOnHandle({ failAfterFirstChunk: true });
    const mockLog = installMockAppLog(app);

    const result = await new Promise<{
      status?: number; contentLength?: string; length: number; body: string; terminated: boolean;
    }>(
      (resolve, reject) => {
        const chunks: Buffer[] = [];
        const request = http.get(`${baseUrl}/api/books/${BOOK_ID}/companion-epub`, (response) => {
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          const finish = (terminated: boolean) => {
            const body = Buffer.concat(chunks);
            resolve({
              ...(response.statusCode !== undefined && { status: response.statusCode }),
              ...(typeof response.headers['content-length'] === 'string' && {
                contentLength: response.headers['content-length'],
              }),
              length: body.length,
              body: body.subarray(-200).toString('utf8'),
              terminated,
            });
          };
          response.on('aborted', () => finish(true));
          response.on('error', () => finish(true));
          response.on('end', () => finish(false));
        });
        request.on('error', () => resolve({ length: 0, body: '', terminated: true }));
        setTimeout(() => reject(new Error('request never settled')), 5000);
      },
    );

    // The connection is cut and the promised length was never delivered, so the client can
    // tell the body is incomplete rather than accepting a truncated EPUB as a whole one.
    expect(result.terminated).toBe(true);
    expect(result.contentLength).toBe(String(PAYLOAD.length));
    expect(result.length).toBeLessThan(PAYLOAD.length);
    // And the shared 500 handler never got to append a JSON envelope under the 200.
    expect(result.body).not.toContain('"error"');

    // The route boundary owns the failure record: `{ bookId, outcome }` and nothing else.
    const boundary = mockLog.spies.warn.mock.calls.map((call) => call[0]);
    expect(boundary).toContainEqual({ bookId: BOOK_ID, outcome: 'stream_error' });
    mockLog.restore();

    await wait(150);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
