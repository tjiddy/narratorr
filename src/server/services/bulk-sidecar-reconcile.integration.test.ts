import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type * as NetworkServiceModule from '../../core/utils/network-service.js';
import type { BookService, BookWithAuthor } from './book.service.js';

/**
 * Real-`downloadRemoteCover` coverage for the #1670 reconcile cover-idempotency invariant.
 *
 * The existing `bulk-operation.service.test.ts` idempotency check hand-flips the mocked DB row from a
 * remote to a local `coverUrl` between runs — proving orchestration branching, not that the real
 * downloader localizes `coverUrl` so the second run skips. Here `downloadRemoteCover` runs FOR REAL
 * (writing into a temp folder and issuing the DB `coverUrl` update); only the network fetch is
 * stubbed at the `network-service` boundary (per spec review F1 — assert zero second-run downloads at
 * the fetch boundary, never by mocking `downloadRemoteCover` itself).
 */

// Hoisted so the (hoisted) vi.mock factory below can close over them without a TDZ error.
const { fetchMock, dispatcherCloseSpy } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  dispatcherCloseSpy: vi.fn().mockResolvedValue(undefined),
}));

// Stub ONLY the network seam: `fetchWithSsrfRedirect` (so no real HTTP/DNS) and
// `createSsrfSafeDispatcher` (so dispatcher.close() hits a spy). `downloadRemoteCover` itself — the
// fs write, the coverUrl localization, the DB update — stays real.
vi.mock('../../core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithSsrfRedirect: fetchMock,
    createSsrfSafeDispatcher: (() => ({ close: dispatcherCloseSpy })) as unknown as typeof actual.createSsrfSafeDispatcher,
  };
});

import { runSidecarReconcile } from './bulk-sidecar-reconcile.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

function makeBookService(): BookService {
  const book = {
    id: 1, title: 'Recon Book', subtitle: null, description: null, publisher: null,
    publishedDate: null, asin: null, isbn: null, seriesName: null, seriesPosition: null,
    genres: [], authors: [], narrators: [],
  } as unknown as BookWithAuthor;
  return { getById: vi.fn().mockResolvedValue(book) } as unknown as BookService;
}

function imageResponse(): Response {
  return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}

/**
 * Recording DB mock. `select…from…where` returns the (mutable) rows; `update…set…where` captures the
 * values production wrote so the test can feed the localized `coverUrl` into a second run.
 */
type ReconcileRow = { id: number; path: string; coverUrl: string | null };

function makeDb(rows: ReconcileRow[]) {
  const captured: { coverUrl?: string | null | undefined } = {};
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })) })),
    update: vi.fn(() => ({
      set: vi.fn((vals: { coverUrl?: string | null }) => {
        captured.coverUrl = vals.coverUrl;
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  return { db: db as unknown as Db, captured, updateSpy: db.update };
}

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function withTmp(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'narratorr-1699-reconcile-'));
    try {
      await fn(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

describe('runSidecarReconcile — real cover localization idempotency (#1699)', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so any queued *Once responses drain between tests
    // — see learning vitest-clearallmocks-once-queue.
    vi.resetAllMocks();
    dispatcherCloseSpy.mockResolvedValue(undefined);
  });

  it('first run downloads + localizes coverUrl, second run fed that value performs zero downloads', withTmp(async (root) => {
    const rows: ReconcileRow[] = [{ id: 1, path: root, coverUrl: 'https://example.com/cover.jpg' }];
    const { db, captured } = makeDb(rows);
    const setTotal = vi.fn();
    const tick = vi.fn();

    // --- Run 1: remote coverUrl → real download + localize ---
    fetchMock.mockResolvedValue(imageResponse());
    await runSidecarReconcile(
      { db, bookService: makeBookService(), log: makeLog(), jobId: 'job-1', where: undefined },
      setTotal, tick,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The real downloader wrote a cover file into the temp folder...
    expect(await pathExists(join(root, 'cover.jpg'))).toBe(true);
    // ...and localized coverUrl to the canonical local form (the value production actually wrote).
    expect(captured.coverUrl).toBe('/api/books/1/cover');

    // --- Run 2: feed the production-written local coverUrl back in → must skip the download ---
    rows[0]!.coverUrl = captured.coverUrl ?? null;
    fetchMock.mockClear();

    await runSidecarReconcile(
      { db, bookService: makeBookService(), log: makeLog(), jobId: 'job-2', where: undefined },
      vi.fn(), vi.fn(),
    );

    // isRemoteCoverUrl('/api/books/1/cover') is false → the cover gate short-circuits, zero fetches.
    expect(fetchMock).not.toHaveBeenCalled();
  }));
});
