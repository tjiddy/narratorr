import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';

vi.mock('../services/cover-download.js', () => ({
  downloadRemoteCoverWithinAdmissionLock: vi.fn().mockResolvedValue('written'),
}));

import { downloadRemoteCoverWithinAdmissionLock } from '../services/cover-download.js';
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

/**
 * Two shapes of read: the batch query (`select().from().where()`) and the per-book in-lock
 * revalidation (`select().from().where().limit(1)`). `freshRows` overrides what the revalidation
 * sees so a case can make a book stale; by default it echoes the batch row unchanged.
 */
function createMockDb(
  rows: Array<{ id: number; coverUrl: string; path: string | null; title?: string }>,
  freshRows?: Map<number, { path: string | null; coverUrl: string | null }>,
) {
  const withTitle = rows.map((r) => ({ title: `Book ${r.id}`, ...r }));
  const byId = new Map(rows.map((r) => [r.id, { path: r.path, coverUrl: r.coverUrl }]));
  let revalidateFor = 0;
  return {
    select: vi.fn().mockImplementation((columns?: Record<string, unknown>) => {
      // Only the revalidation projects exactly { path, coverUrl }.
      const isRevalidation = !!columns && Object.keys(columns).length === 2 && 'path' in columns && 'coverUrl' in columns;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            if (!isRevalidation) return Promise.resolve(withTitle);
            const id = rows[revalidateFor++]?.id ?? -1;
            const fresh = freshRows?.get(id) ?? byId.get(id);
            return { limit: vi.fn().mockResolvedValue(fresh ? [fresh] : []) };
          }),
        }),
      };
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

    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledTimes(2);
    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledWith(
      1, '/books/book1', 'https://cdn.example.com/cover1.jpg',
      expect.anything(), log,
    );
    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledWith(
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
    vi.mocked(downloadRemoteCoverWithinAdmissionLock)
      .mockResolvedValueOnce('written')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('written');

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledTimes(3);
  });

  it('logs per-item warning on individual download failure', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCoverWithinAdmissionLock).mockResolvedValueOnce('failed');

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
    vi.mocked(downloadRemoteCoverWithinAdmissionLock)
      .mockResolvedValueOnce('written')
      .mockResolvedValueOnce('failed');

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect((log.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ downloaded: 1, failed: 1, total: 2 }),
      expect.stringContaining('backfill'),
    );
  });

  it('is idempotent — returns empty when SQL query finds no remote-URL books', async () => {
    const mockDb = createMockDb([]);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
    expect((log.debug as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining('no books'),
    );
  });

  it('does not throw — errors are caught and logged', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCoverWithinAdmissionLock).mockRejectedValueOnce(new Error('Unexpected'));

    await expect(runCoverBackfill(inject<Db>(mockDb), log)).resolves.toBeUndefined();
  });

  it("fires a 'metadata' connector refresh per book whose cover was 'written' (with the extended title)", async () => {
    const notifyRefresh = vi.fn().mockResolvedValue(undefined);
    const connector = inject<ConnectorService>({ notifyRefresh });
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1', title: 'Dune' },
      { id: 2, coverUrl: 'https://cdn.example.com/cover2.jpg', path: '/books/book2', title: 'Hyperion' },
    ]);
    vi.mocked(downloadRemoteCoverWithinAdmissionLock)
      .mockResolvedValueOnce('written')
      .mockResolvedValueOnce('failed');

    await runCoverBackfill(inject<Db>(mockDb), log, connector);

    expect(notifyRefresh).toHaveBeenCalledTimes(1);
    expect(notifyRefresh).toHaveBeenCalledWith('metadata', [
      { bookId: 1, title: 'Dune', authorName: null, libraryPath: '/books/book1' },
    ]);
  });

  /**
   * #2369 AC3/AC12. The batch query is a pre-lock snapshot: by the time a book's own section is
   * held, a rename or delete may have moved it. Writing `cover.<ext>` at the snapshot path would
   * drop the file into a folder the book no longer owns.
   */
  describe('in-lock revalidation of the batch snapshot', () => {
    it('skips a book whose path moved between the batch query and its own section', async () => {
      const mockDb = createMockDb(
        [{ id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/old' }],
        new Map([[1, { path: '/books/renamed', coverUrl: 'https://cdn.example.com/cover1.jpg' }]]),
      );

      await runCoverBackfill(inject<Db>(mockDb), log);

      expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
    });

    it('skips a book deleted between the batch query and its own section', async () => {
      const mockDb = createMockDb(
        [{ id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/gone' }],
        new Map([[1, { path: null, coverUrl: null }]]),
      );

      await runCoverBackfill(inject<Db>(mockDb), log);

      expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
    });

    it('skips a book whose coverUrl was localized in the meantime', async () => {
      const mockDb = createMockDb(
        [{ id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' }],
        new Map([[1, { path: '/books/book1', coverUrl: '/api/books/1/cover' }]]),
      );

      await runCoverBackfill(inject<Db>(mockDb), log);

      expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
    });

    it('counts a stale book as stale, never as a failure the operator must act on', async () => {
      const mockDb = createMockDb(
        [{ id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/old' }],
        new Map([[1, { path: '/books/renamed', coverUrl: 'https://cdn.example.com/cover1.jpg' }]]),
      );

      await runCoverBackfill(inject<Db>(mockDb), log);

      expect((log.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({ downloaded: 0, failed: 0, stale: 1, total: 1 }),
        expect.stringContaining('backfill'),
      );
    });
  });

  it('does not fire a refresh when no connector is provided (silent no-op)', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCoverWithinAdmissionLock).mockResolvedValueOnce('written');

    await expect(runCoverBackfill(inject<Db>(mockDb), log)).resolves.toBeUndefined();
  });
});
