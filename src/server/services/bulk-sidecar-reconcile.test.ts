import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';

// reconcileBookSidecars composes two cross-module helpers — mock them at their module boundaries
// (NOT same-module, so vi.mock intercepts) and assert the orchestration + failure accounting.
vi.mock('../utils/opf-writer.js', () => ({
  writeOpfSidecar: vi.fn().mockResolvedValue('written'),
}));
vi.mock('./cover-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cover-download.js')>()),
  downloadRemoteCover: vi.fn().mockResolvedValue('written'),
}));

import { reconcileBookSidecars } from './bulk-sidecar-reconcile.js';
import { writeOpfSidecar } from '../utils/opf-writer.js';
import { downloadRemoteCover } from './cover-download.js';
import type { ConnectorService } from './connector.service.js';

const writeOpfMock = vi.mocked(writeOpfSidecar);
const downloadMock = vi.mocked(downloadRemoteCover);

function makeLog(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info' } as unknown as FastifyBaseLogger;
}

const bookService = { getById: vi.fn() } as unknown as BookService;
const db = {} as unknown as Db;

let notifyRefresh: ReturnType<typeof vi.fn>;

function run(overrides: { bookFolder?: string; coverUrl?: string | null; title?: string } = {}) {
  return reconcileBookSidecars({
    bookId: 1,
    title: overrides.title ?? 'Book One',
    bookFolder: overrides.bookFolder ?? '/lib/Author/Book',
    coverUrl: overrides.coverUrl ?? null,
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

  it('OPF written + remote cover materialized → success (returns false)', async () => {
    const failed = await run({ coverUrl: 'https://example.com/c.png' });
    expect(downloadMock).toHaveBeenCalledWith(1, '/lib/Author/Book', 'https://example.com/c.png', db, expect.anything());
    expect(failed).toBe(false);
  });

  it("OPF write returns 'failed' → counted as failure (returns true)", async () => {
    writeOpfMock.mockResolvedValue('failed');
    expect(await run({ coverUrl: 'https://example.com/c.png' })).toBe(true);
  });

  it("OPF 'skipped' (foreign/missing) is NOT a failure", async () => {
    writeOpfMock.mockResolvedValue('skipped');
    expect(await run()).toBe(false);
  });

  it("attempted cover download returning 'failed' → counted as failure", async () => {
    downloadMock.mockResolvedValue('failed');
    expect(await run({ coverUrl: 'https://example.com/c.png' })).toBe(true);
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
    const failed = await run({ coverUrl: 'https://example.com/c.png' });
    expect(failed).toBe(true); // OPF failure still counts
    expect(notifyRefresh).toHaveBeenCalledTimes(1); // but the cover write still warrants a refresh
  });

  it('coverUrl=null → no download attempt, not a failure', async () => {
    expect(await run({ coverUrl: null })).toBe(false);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('already-local coverUrl → no remote download attempt, not a failure', async () => {
    expect(await run({ coverUrl: '/api/books/1/cover' })).toBe(false);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('single-file pointer (.m4b) path → BOTH OPF and cover skipped, not a failure (F4)', async () => {
    const failed = await run({ bookFolder: '/audiobooks/Doctor Sleep.m4b', coverUrl: 'https://example.com/c.png' });
    expect(failed).toBe(false);
    expect(writeOpfMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
  });
});
