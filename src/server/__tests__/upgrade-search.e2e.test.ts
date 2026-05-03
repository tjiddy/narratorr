import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { books } from '../../db/schema.js';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { runUpgradeSearchJob } from '../jobs/search.js';
import { createMockLogger } from './helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/index.js';

/**
 * #755 Wave 11.2 (AC4) — DB-backed integration test for upgrade-search eligibility.
 *
 * Why this exists separately from `src/server/jobs/search.test.ts`:
 * the unit tests there inject a mocked `BookService.getMonitoredBooks()` array,
 * which means a regression in the actual selector at `src/server/services/book.service.ts:357`
 * (the `monitorForUpgrades = true AND status = 'imported'` filter) would not fail
 * those tests. This file boots the full service graph against a real libSQL DB
 * and exercises the real selector, only mocking the indexer/download-orchestrator
 * I/O boundaries.
 */
describe('Upgrade-search eligibility — DB-backed selector (#755)', () => {
  let e2e: E2EApp;
  let log: FastifyBaseLogger;

  beforeAll(async () => {
    e2e = await createE2EApp();
    log = createMockLogger() as unknown as FastifyBaseLogger;
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  beforeEach(async () => {
    // Reset book table between cases so seeded eligibility flags are deterministic.
    await e2e.db.delete(books);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Seed an imported book row directly with the per-book eligibility flag. */
  async function seedBook(overrides: Partial<typeof books.$inferInsert> = {}): Promise<number> {
    const [row] = await e2e.db
      .insert(books)
      .values({
        title: 'The Way of Kings',
        status: 'imported',
        path: '/library/Sanderson/The Way of Kings',
        monitorForUpgrades: true,
        // 100 MB over 1 hour = 100 MB/hr existing quality
        audioTotalSize: 100 * 1024 * 1024,
        audioDuration: 3600,
        ...overrides,
      })
      .returning({ id: books.id });
    return row!.id;
  }

  it('runUpgradeSearchJob picks up books with monitorForUpgrades=true AND status=imported via the real selector', async () => {
    const bookId = await seedBook();

    // 500 MB over 3600s = 500 MB/hr — clearly higher quality than seeded 100 MB/hr.
    const higherResult: SearchResult = {
      title: 'The Way of Kings (Higher Quality)',
      protocol: 'torrent',
      indexer: 'AudioBookBay',
      seeders: 25,
      size: 500 * 1024 * 1024,
      downloadUrl: 'magnet:?xt=urn:btih:upgrade',
    };

    const searchAllSpy = vi.spyOn(e2e.services.indexerSearch, 'searchAll').mockResolvedValue([higherResult]);
    const grabSpy = vi
      .spyOn(e2e.services.downloadOrchestrator, 'grab')
      .mockResolvedValue({ id: 1, title: higherResult.title } as never);

    const result = await runUpgradeSearchJob(
      e2e.services.settings,
      e2e.services.book,
      e2e.services.indexerSearch,
      e2e.services.downloadOrchestrator,
      log,
    );

    // Eligibility query (real `BookService.getMonitoredBooks()`) returned the seeded book,
    // and the job ran the indexer + grab pipeline against it.
    expect(searchAllSpy).toHaveBeenCalledTimes(1);
    expect(grabSpy).toHaveBeenCalledWith(
      expect.objectContaining({ bookId, downloadUrl: 'magnet:?xt=urn:btih:upgrade' }),
    );
    expect(result.searched).toBe(1);
    expect(result.grabbed).toBe(1);
  });

  it('skips books with monitorForUpgrades=false even when status=imported', async () => {
    await seedBook({ monitorForUpgrades: false });

    const searchAllSpy = vi.spyOn(e2e.services.indexerSearch, 'searchAll').mockResolvedValue([]);
    const grabSpy = vi.spyOn(e2e.services.downloadOrchestrator, 'grab');

    const result = await runUpgradeSearchJob(
      e2e.services.settings,
      e2e.services.book,
      e2e.services.indexerSearch,
      e2e.services.downloadOrchestrator,
      log,
    );

    // `getMonitoredBooks()` filters this row out — indexer is never queried.
    expect(searchAllSpy).not.toHaveBeenCalled();
    expect(grabSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ searched: 0, grabbed: 0 });
  });

  it('skips books with monitorForUpgrades=true but status!=imported (e.g., wanted)', async () => {
    await seedBook({ status: 'wanted', monitorForUpgrades: true });

    const searchAllSpy = vi.spyOn(e2e.services.indexerSearch, 'searchAll').mockResolvedValue([]);
    const grabSpy = vi.spyOn(e2e.services.downloadOrchestrator, 'grab');

    const result = await runUpgradeSearchJob(
      e2e.services.settings,
      e2e.services.book,
      e2e.services.indexerSearch,
      e2e.services.downloadOrchestrator,
      log,
    );

    expect(searchAllSpy).not.toHaveBeenCalled();
    expect(grabSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ searched: 0, grabbed: 0 });
  });
});
