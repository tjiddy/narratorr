import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { BookService } from './book.service.js';

// Mock cross-module seams so orchestration and failure accounting remain observable.
vi.mock('../utils/opf-writer.js', () => ({
  writeOpfSidecarWithinAdmissionLock: vi.fn().mockResolvedValue('written'),
}));
vi.mock('./cover-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cover-download.js')>()),
  downloadRemoteCoverWithinAdmissionLock: vi.fn().mockResolvedValue('written'),
}));

import { reconcileBookSidecars, runSidecarReconcile } from './bulk-sidecar-reconcile.js';
import type { BulkJobFailure } from './bulk-job.js';
import { writeOpfSidecarWithinAdmissionLock } from '../utils/opf-writer.js';
import { downloadRemoteCoverWithinAdmissionLock } from './cover-download.js';
import type { ConnectorService } from './connector.service.js';

const writeOpfMock = vi.mocked(writeOpfSidecarWithinAdmissionLock);
const downloadMock = vi.mocked(downloadRemoteCoverWithinAdmissionLock);

function makeLog(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info' } as unknown as FastifyBaseLogger;
}

const bookService = { getById: vi.fn() } as unknown as BookService;

type FreshRow = { path: string | null; coverUrl: string | null };

/**
 * The section re-reads `books.path`/`coverUrl` (#2369 F2), so the row is part of every fixture.
 * `rows` are served to successive single-row reads in the order the per-book loop makes them.
 */
function makeDb(rows: FreshRow[], batch: unknown[] = []): Db {
  let next = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const pending = Promise.resolve(batch) as Promise<unknown[]> & { limit: (n: number) => Promise<FreshRow[]> };
          pending.limit = () => {
            const row = rows[next++];
            return Promise.resolve(row ? [row] : []);
          };
          return pending;
        },
      }),
    }),
  } as unknown as Db;
}

let notifyRefresh: ReturnType<typeof vi.fn>;

function run(overrides: { bookFolder?: string; coverUrl?: string | null; title?: string; fresh?: FreshRow | null } = {}) {
  const bookFolder = overrides.bookFolder ?? '/lib/Author/Book';
  const coverUrl = overrides.coverUrl ?? null;
  // Default: nothing moved between the batch query and the section.
  const fresh = overrides.fresh === undefined ? { path: bookFolder, coverUrl } : overrides.fresh;
  const db = makeDb(fresh === null ? [{ path: null, coverUrl: null }] : [fresh]);
  return reconcileBookSidecars({
    bookId: 1,
    title: overrides.title ?? 'Book One',
    bookFolder,
    coverUrl,
    bookService,
    db,
    log: makeLog(),
    connectorService: { notifyRefresh } as unknown as ConnectorService,
  });
}

describe('reconcileBookSidecars (#1670)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeOpfMock.mockResolvedValue('written');
    downloadMock.mockResolvedValue('written');
    notifyRefresh = vi.fn().mockResolvedValue(undefined);
  });

  it('writes OPF with enabled:true (reconcile ignores the global writeOpf setting)', async () => {
    await run();
    expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bookId: 1, bookFolder: '/lib/Author/Book' }));
  });

  it('OPF written + remote cover materialized → success', async () => {
    const outcome = await run({ coverUrl: 'https://example.com/c.png' });
    expect(downloadMock).toHaveBeenCalledWith(1, '/lib/Author/Book', 'https://example.com/c.png', expect.anything(), expect.anything(), expect.any(Function));
    expect(outcome).toEqual({ failed: false });
  });

  it("OPF write returns 'failed' → counted as failure", async () => {
    writeOpfMock.mockResolvedValue('failed');
    expect(await run({ coverUrl: 'https://example.com/c.png' })).toEqual({ failed: true, reason: 'OPF write failed' });
  });

  it("OPF 'skipped' (foreign/missing) is NOT a failure", async () => {
    writeOpfMock.mockResolvedValue('skipped');
    expect(await run()).toEqual({ failed: false });
  });

  it("attempted cover download returning 'failed' → counted as failure", async () => {
    downloadMock.mockResolvedValue('failed');
    expect(await run({ coverUrl: 'https://example.com/c.png' })).toEqual({ failed: true, reason: 'Cover download failed' });
  });

  it("fires one 'metadata' refresh with the threaded title + null authorName when OPF was written", async () => {
    writeOpfMock.mockResolvedValue('written');
    await run({ title: 'Project Hail Mary' });
    expect(notifyRefresh).toHaveBeenCalledTimes(1);
    expect(notifyRefresh).toHaveBeenCalledWith('metadata', [
      { bookId: 1, title: 'Project Hail Mary', authorName: null, libraryPath: '/lib/Author/Book' },
    ]);
  });

  it("fires a refresh when only the cover was 'written' (OPF skipped)", async () => {
    writeOpfMock.mockResolvedValue('skipped');
    downloadMock.mockResolvedValue('written');
    await run({ coverUrl: 'https://example.com/c.png' });
    expect(notifyRefresh).toHaveBeenCalledTimes(1);
    expect(notifyRefresh).toHaveBeenCalledWith('metadata', [expect.objectContaining({ bookId: 1, libraryPath: '/lib/Author/Book' })]);
  });

  it("fires NO refresh when nothing was written (OPF skipped, no cover)", async () => {
    writeOpfMock.mockResolvedValue('skipped');
    await run();
    expect(notifyRefresh).not.toHaveBeenCalled();
  });

  it("fires NO refresh when the only cover attempt 'failed' and OPF skipped", async () => {
    writeOpfMock.mockResolvedValue('skipped');
    downloadMock.mockResolvedValue('failed');
    await run({ coverUrl: 'https://example.com/c.png' });
    expect(notifyRefresh).not.toHaveBeenCalled();
  });

  it("fires a refresh when the cover is 'written' even though the OPF 'failed' (file materialized)", async () => {
    writeOpfMock.mockResolvedValue('failed');
    downloadMock.mockResolvedValue('written');
    const outcome = await run({ coverUrl: 'https://example.com/c.png' });
    expect(outcome.failed).toBe(true);
    expect(notifyRefresh).toHaveBeenCalledTimes(1);
  });

  it('coverUrl=null → no download attempt, not a failure', async () => {
    expect(await run({ coverUrl: null })).toEqual({ failed: false });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('already-local coverUrl → no remote download attempt, not a failure', async () => {
    expect(await run({ coverUrl: '/api/books/1/cover' })).toEqual({ failed: false });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('single-file pointer (.m4b) path → BOTH OPF and cover skipped, not a failure (F4)', async () => {
    const outcome = await run({ bookFolder: '/audiobooks/Doctor Sleep.m4b', coverUrl: 'https://example.com/c.png' });
    expect(outcome).toEqual({ failed: false });
    expect(writeOpfMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('#2495: single-file pointer (.mp4) path takes the same skip, not a failure', async () => {
    const outcome = await run({
      bookFolder: '/audiobooks/FortuneFunhouseMissFortuneMysteriesBook19.mp4',
      coverUrl: 'https://example.com/c.png',
    });
    expect(outcome).toEqual({ failed: false });
    expect(writeOpfMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  /**
   * #2369 F2. The batch query is a pre-lock snapshot. Forwarding it into the section let a rename
   * land in between and split the two sidecars across two folders: the OPF writer's own ownership
   * re-read skipped, while the cover half still wrote into the folder the book had vacated.
   */
  describe('the batch snapshot is re-read inside the section (AC3, F2)', () => {
    it('retargets BOTH sidecars and the refresh at the folder the row names now', async () => {
      const outcome = await run({
        bookFolder: '/lib/Author/Old',
        coverUrl: 'https://example.com/c.png',
        fresh: { path: '/lib/Author/Renamed', coverUrl: 'https://example.com/c.png' },
      });

      expect(outcome).toEqual({ failed: false });
      expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ bookFolder: '/lib/Author/Renamed' }));
      expect(downloadMock).toHaveBeenCalledWith(1, '/lib/Author/Renamed', 'https://example.com/c.png', expect.anything(), expect.anything(), expect.any(Function));
      expect(notifyRefresh).toHaveBeenCalledWith('metadata', [expect.objectContaining({ libraryPath: '/lib/Author/Renamed' })]);
    });

    it('takes the fresh coverUrl, so a cover localized since the batch query is not re-downloaded', async () => {
      const outcome = await run({
        bookFolder: '/lib/Author/Book',
        coverUrl: 'https://example.com/c.png',
        fresh: { path: '/lib/Author/Book', coverUrl: '/api/books/1/cover' },
      });

      expect(outcome).toEqual({ failed: false });
      expect(downloadMock).not.toHaveBeenCalled();
    });

    it('writes nothing when the book lost its row or its path while the section was queued', async () => {
      const outcome = await run({ coverUrl: 'https://example.com/c.png', fresh: null });

      // Not a failure: the book legitimately moved on and the operator has nothing to fix.
      expect(outcome).toEqual({ failed: false });
      expect(writeOpfMock).not.toHaveBeenCalled();
      expect(downloadMock).not.toHaveBeenCalled();
      expect(notifyRefresh).not.toHaveBeenCalled();
    });

    it('writes nothing when the row now points at a loose audio file', async () => {
      const outcome = await run({
        bookFolder: '/lib/Author/Book',
        coverUrl: 'https://example.com/c.png',
        fresh: { path: '/audiobooks/Doctor Sleep.m4b', coverUrl: 'https://example.com/c.png' },
      });

      expect(outcome).toEqual({ failed: false });
      expect(writeOpfMock).not.toHaveBeenCalled();
      expect(downloadMock).not.toHaveBeenCalled();
    });
  });
});

function opfFailsWith(cause: unknown) {
  writeOpfMock.mockImplementation(async (args) => {
    args.onFailure?.(cause);
    return 'failed';
  });
}

function coverFailsWith(cause: unknown) {
  downloadMock.mockImplementation(async (_bookId, _path, _url, _db, _log, onFailure) => {
    onFailure?.(cause);
    return 'failed';
  });
}

function makeEnoent(): NodeJS.ErrnoException {
  return Object.assign(
    new Error("ENOENT: no such file or directory, open '/audiobooks/Jim Butcher/Codex Alera/04 - Captain's Fury/metadata.opf'"),
    { code: 'ENOENT' },
  );
}

describe('reconcileBookSidecars — named failure reasons (#2159)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeOpfMock.mockResolvedValue('written');
    downloadMock.mockResolvedValue('written');
    notifyRefresh = vi.fn().mockResolvedValue(undefined);
  });

  it('names the underlying OPF cause — the live ENOENT case', async () => {
    opfFailsWith(makeEnoent());
    const outcome = await run();
    expect(outcome.failed).toBe(true);
    expect(outcome.failed && outcome.reason).toContain('ENOENT');
    expect(outcome.failed && outcome.reason).not.toBe('OPF write failed');
  });

  it('falls back to the generic OPF reason when the step reports no cause', async () => {
    writeOpfMock.mockResolvedValue('failed');
    expect(await run()).toEqual({ failed: true, reason: 'OPF write failed' });
  });

  it('names the underlying cover cause', async () => {
    coverFailsWith('Cover download returned HTTP 403');
    expect(await run({ coverUrl: 'https://example.com/c.png' }))
      .toEqual({ failed: true, reason: 'Cover download returned HTTP 403' });
  });

  it('falls back to the generic cover reason when the step reports no cause', async () => {
    downloadMock.mockResolvedValue('failed');
    expect(await run({ coverUrl: 'https://example.com/c.png' }))
      .toEqual({ failed: true, reason: 'Cover download failed' });
  });

  // Undici nests the actionable diagnostic under a generic TypeError.cause.
  it("surfaces an undici cause's ENOTFOUND rather than the generic 'fetch failed'", async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND covers.example.com'), { code: 'ENOTFOUND' });
    coverFailsWith(new TypeError('fetch failed', { cause }));
    const outcome = await run({ coverUrl: 'https://example.com/c.png' });
    expect(outcome.failed && outcome.reason).toBe('ENOTFOUND: getaddrinfo ENOTFOUND covers.example.com');
    expect(outcome.failed && outcome.reason).not.toContain('fetch failed');
  });

  it('composes both causes, OPF first, when the OPF and the cover both fail', async () => {
    opfFailsWith(makeEnoent());
    coverFailsWith('Cover response is not an image (content-type: text/html)');
    const outcome = await run({ coverUrl: 'https://example.com/c.png' });
    expect(outcome).toEqual({
      failed: true,
      reason: "ENOENT: no such file or directory, open '/audiobooks/Jim Butcher/Codex Alera/04 - Captain's Fury/metadata.opf'; Cover response is not an image (content-type: text/html)",
    });
  });
});

describe('runSidecarReconcile — one tick, one detail per book (#2159)', () => {
  function makeDeps(rows: Array<{ id: number; path: string | null; coverUrl: string | null; title: string }>) {
    return {
      // Each eligible row is re-read inside its own section before either sidecar is written.
      db: makeDb(rows.map((r) => ({ path: r.path, coverUrl: r.coverUrl })), rows),
      bookService,
      log: makeLog(),
      jobId: 'job-1',
      where: undefined,
    };
  }

  function collectTicks() {
    const ticks: Array<{ isFailure: boolean; detail?: BulkJobFailure }> = [];
    return {
      ticks,
      tick: (isFailure: boolean, detail?: BulkJobFailure) => { ticks.push({ isFailure, ...(detail ? { detail } : {}) }); },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    writeOpfMock.mockResolvedValue('written');
    downloadMock.mockResolvedValue('written');
    notifyRefresh = vi.fn().mockResolvedValue(undefined);
  });

  it('ticks ONCE with ONE detail when both the OPF and the cover fail for the same book', async () => {
    opfFailsWith(makeEnoent());
    coverFailsWith('Cover download returned HTTP 500');
    const { ticks, tick } = collectTicks();

    await runSidecarReconcile(
      makeDeps([{ id: 226, path: '/lib/Jim Butcher/Codex Alera/04', coverUrl: 'https://example.com/c.png', title: "Captain's Fury" }]),
      () => {},
      tick,
    );

    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.isFailure).toBe(true);
    expect(ticks[0]!.detail).toEqual({
      bookId: 226,
      title: "Captain's Fury",
      error: "ENOENT: no such file or directory, open '/audiobooks/Jim Butcher/Codex Alera/04 - Captain's Fury/metadata.opf'; Cover download returned HTTP 500",
    });
  });

  it('records no detail and ticks a success for a clean book', async () => {
    const { ticks, tick } = collectTicks();
    await runSidecarReconcile(
      makeDeps([{ id: 7, path: '/lib/A/B', coverUrl: null, title: 'Clean Book' }]),
      () => {},
      tick,
    );
    expect(ticks).toEqual([{ isFailure: false }]);
  });

  it('routes a thrown per-book error through the shared formatter', async () => {
    writeOpfMock.mockRejectedValue(new Error('Boom at https://covers.example.com/c.jpg?apikey=SECRET'));
    const { ticks, tick } = collectTicks();

    await runSidecarReconcile(
      makeDeps([{ id: 9, path: '/lib/A/B', coverUrl: null, title: 'Thrown Book' }]),
      () => {},
      tick,
    );

    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.isFailure).toBe(true);
    expect(ticks[0]!.detail?.bookId).toBe(9);
    expect(ticks[0]!.detail?.title).toBe('Thrown Book');
    expect(ticks[0]!.detail?.error).not.toContain('SECRET');
    expect(ticks[0]!.detail?.error).toContain('Boom at https://covers.example.com/c.jpg');
  });

  it('bounds the composed reason to 200 characters, keeping the OPF cause that leads it', async () => {
    opfFailsWith(Object.assign(new Error(`ENOENT: ${'x'.repeat(300)}`), { code: 'ENOENT' }));
    coverFailsWith('Cover download returned HTTP 500');
    const { ticks, tick } = collectTicks();

    await runSidecarReconcile(
      makeDeps([{ id: 1, path: '/lib/A/B', coverUrl: 'https://example.com/c.png', title: 'Long' }]),
      () => {},
      tick,
    );

    const error = ticks[0]!.detail!.error;
    expect(error).toHaveLength(200);
    expect(error.startsWith('ENOENT: ')).toBe(true);
    expect(error.endsWith('…')).toBe(true);
  });
});
