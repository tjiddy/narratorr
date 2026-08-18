import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type * as NetworkServiceModule from '@core/utils/network-service.js';
import type { BookService, BookWithAuthor } from './book.service.js';

/** Exercise real cover localization and second-run idempotency while stubbing only the network. */

// Hoist these so the mock factory can close over them without a TDZ error.
const { fetchMock, dispatcherCloseSpy } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  dispatcherCloseSpy: vi.fn().mockResolvedValue(undefined),
}));

// Cover writing and localization remain real; only HTTP and dispatcher creation are stubbed.
vi.mock('@core/utils/network-service.js', async (importActual) => {
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

/** Return mutable rows and capture production's coverUrl update for the second run. */
type ReconcileRow = { id: number; path: string; coverUrl: string | null };

function makeDb(rows: ReconcileRow[]) {
  const captured: { coverUrl?: string | null | undefined } = {};
  // The batch query resolves every row; each section then re-reads its own row (#2369 F2).
  const singleRow = (): Promise<ReconcileRow[]> => Promise.resolve(rows.slice(0, 1));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve(rows), { limit: singleRow })),
      })),
    })),
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
    // resetAllMocks drains queued Once implementations; clearAllMocks does not.
    vi.resetAllMocks();
    dispatcherCloseSpy.mockResolvedValue(undefined);
  });

  it('first run downloads + localizes coverUrl, second run fed that value performs zero downloads', withTmp(async (root) => {
    const rows: ReconcileRow[] = [{ id: 1, path: root, coverUrl: 'https://example.com/cover.jpg' }];
    const { db, captured } = makeDb(rows);
    const setTotal = vi.fn();
    const tick = vi.fn();

    fetchMock.mockResolvedValue(imageResponse());
    await runSidecarReconcile(
      { db, bookService: makeBookService(), log: makeLog(), jobId: 'job-1', where: undefined },
      setTotal, tick,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await pathExists(join(root, 'cover.jpg'))).toBe(true);
    expect(captured.coverUrl).toBe('/api/books/1/cover');

    rows[0]!.coverUrl = captured.coverUrl ?? null;
    fetchMock.mockClear();

    await runSidecarReconcile(
      { db, bookService: makeBookService(), log: makeLog(), jobId: 'job-2', where: undefined },
      vi.fn(), vi.fn(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  }));
});
