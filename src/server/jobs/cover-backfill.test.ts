import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

vi.mock('../services/cover-download.js', () => ({
  downloadRemoteCover: vi.fn().mockResolvedValue('written'),
}));

import { downloadRemoteCover } from '../services/cover-download.js';
import { runCoverBackfill } from './cover-backfill.js';
import type { ConnectorService } from '../services/connector.service.js';

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  });
}

function createMockDb(rows: Array<{ id: number; coverUrl: string; path: string | null; title?: string }>) {
  const withTitle = rows.map((r) => ({ title: `Book ${r.id}`, ...r }));
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(withTitle),
      }),
    }),
  };
}

describe('runCoverBackfill', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    log = createMockLogger();
  });

  it('downloads covers for books with remote coverUrl and populated path', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
      { id: 2, coverUrl: 'https://cdn.example.com/cover2.jpg', path: '/books/book2' },
    ]);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).toHaveBeenCalledTimes(2);
    expect(downloadRemoteCover).toHaveBeenCalledWith(
      1, '/books/book1', 'https://cdn.example.com/cover1.jpg',
      expect.anything(), log,
    );
    expect(downloadRemoteCover).toHaveBeenCalledWith(
      2, '/books/book2', 'https://cdn.example.com/cover2.jpg',
      expect.anything(), log,
    );
  });

  it('queries with SQL predicate enforcing coverUrl LIKE http% AND path IS NOT NULL', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: whereFn,
        }),
      }),
    };

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(whereFn).toHaveBeenCalledTimes(1);
    const predicate = whereFn.mock.calls[0]![0];

    // Recursive Drizzle expression inspector (established pattern from book-list.service.test.ts)
    function containsSubstring(val: unknown, substring: string): boolean {
      if (typeof val === 'string') return val.includes(substring);
      if (Array.isArray(val)) return val.some((v) => containsSubstring(v, substring));
      if (val && typeof val === 'object') {
        if ('queryChunks' in val) return containsSubstring((val as { queryChunks: unknown[] }).queryChunks, substring);
        if ('value' in val) return containsSubstring((val as { value: unknown }).value, substring);
        if ('name' in val) return containsSubstring((val as { name: unknown }).name, substring);
      }
      return false;
    }

    // Both halves of the predicate must be present
    expect(containsSubstring(predicate, 'cover_url')).toBe(true);
    expect(containsSubstring(predicate, 'http%')).toBe(true);
    expect(containsSubstring(predicate, 'path')).toBe(true);
  });

  it('continues processing remaining books when one download fails', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
      { id: 2, coverUrl: 'https://cdn.example.com/cover2.jpg', path: '/books/book2' },
      { id: 3, coverUrl: 'https://cdn.example.com/cover3.jpg', path: '/books/book3' },
    ]);
    vi.mocked(downloadRemoteCover)
      .mockResolvedValueOnce('written')
      .mockResolvedValueOnce('failed') // second one fails
      .mockResolvedValueOnce('written');

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).toHaveBeenCalledTimes(3);
  });

  it('logs per-item warning on individual download failure', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCover).mockResolvedValueOnce('failed');

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      expect.stringContaining('backfill'),
    );
  });

  it('logs summary stats after backfill completes', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
      { id: 2, coverUrl: 'https://cdn.example.com/cover2.jpg', path: '/books/book2' },
    ]);
    vi.mocked(downloadRemoteCover)
      .mockResolvedValueOnce('written')
      .mockResolvedValueOnce('failed');

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect((log.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ downloaded: 1, failed: 1, total: 2 }),
      expect.stringContaining('backfill'),
    );
  });

  it('is idempotent — returns empty when SQL query finds no remote-URL books', async () => {
    // After first backfill, all coverUrl values are local (/api/books/:id/cover)
    // The SQL LIKE 'http%' filter excludes them, returning empty set
    const mockDb = createMockDb([]);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).not.toHaveBeenCalled();
    expect((log.debug as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining('no books'),
    );
  });

  it('does not throw — errors are caught and logged', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCover).mockRejectedValueOnce(new Error('Unexpected'));

    // Should not throw
    await expect(runCoverBackfill(inject<Db>(mockDb), log)).resolves.toBeUndefined();
  });

  it("fires a 'metadata' connector refresh per book whose cover was 'written' (with the extended title)", async () => {
    const notifyRefresh = vi.fn().mockResolvedValue(undefined);
    const connector = inject<ConnectorService>({ notifyRefresh });
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1', title: 'Dune' },
      { id: 2, coverUrl: 'https://cdn.example.com/cover2.jpg', path: '/books/book2', title: 'Hyperion' },
    ]);
    vi.mocked(downloadRemoteCover)
      .mockResolvedValueOnce('written')
      .mockResolvedValueOnce('failed'); // second cover did not materialize → no refresh

    await runCoverBackfill(inject<Db>(mockDb), log, connector);

    expect(notifyRefresh).toHaveBeenCalledTimes(1);
    expect(notifyRefresh).toHaveBeenCalledWith('metadata', [
      { bookId: 1, title: 'Dune', authorName: null, libraryPath: '/books/book1' },
    ]);
  });

  it('does not fire a refresh when no connector is provided (silent no-op)', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCover).mockResolvedValueOnce('written');

    await expect(runCoverBackfill(inject<Db>(mockDb), log)).resolves.toBeUndefined();
  });
});
