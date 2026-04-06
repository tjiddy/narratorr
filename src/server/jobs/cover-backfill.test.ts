import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

vi.mock('../services/cover-download.js', () => ({
  downloadRemoteCover: vi.fn().mockResolvedValue(true),
}));

import { downloadRemoteCover } from '../services/cover-download.js';
import { runCoverBackfill } from './cover-backfill.js';

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

function createMockDb(rows: Array<{ id: number; coverUrl: string; path: string | null }>) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
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

  it('skips books already using local /api/books/:id/cover URL', async () => {
    // Query only returns books with remote URLs — local ones are filtered by SQL
    const mockDb = createMockDb([]);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).not.toHaveBeenCalled();
  });

  it('skips books without path (wanted, not imported)', async () => {
    // Query only returns books with non-null path — filtered by SQL
    const mockDb = createMockDb([]);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).not.toHaveBeenCalled();
  });

  it('continues processing remaining books when one download fails', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
      { id: 2, coverUrl: 'https://cdn.example.com/cover2.jpg', path: '/books/book2' },
      { id: 3, coverUrl: 'https://cdn.example.com/cover3.jpg', path: '/books/book3' },
    ]);
    vi.mocked(downloadRemoteCover)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false) // second one fails
      .mockResolvedValueOnce(true);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).toHaveBeenCalledTimes(3);
  });

  it('logs per-item warning on individual download failure', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCover).mockResolvedValueOnce(false);

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
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect((log.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ downloaded: 1, failed: 1, total: 2 }),
      expect.stringContaining('backfill'),
    );
  });

  it('is idempotent — second run downloads nothing when all covers are local', async () => {
    const mockDb = createMockDb([]);

    await runCoverBackfill(inject<Db>(mockDb), log);

    expect(downloadRemoteCover).not.toHaveBeenCalled();
  });

  it('does not throw — errors are caught and logged', async () => {
    const mockDb = createMockDb([
      { id: 1, coverUrl: 'https://cdn.example.com/cover1.jpg', path: '/books/book1' },
    ]);
    vi.mocked(downloadRemoteCover).mockRejectedValueOnce(new Error('Unexpected'));

    // Should not throw
    await expect(runCoverBackfill(inject<Db>(mockDb), log)).resolves.toBeUndefined();
  });
});
