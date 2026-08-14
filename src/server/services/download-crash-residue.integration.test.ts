import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { downloadClients, downloads } from '@db/schema.js';
import { BookService } from './book.service.js';
import { DownloadService, DuplicateDownloadError } from './download.service.js';
import { gatherBookBlockers, classifyBlockers, isPipelineBlocker } from './download-blockers.js';
import { clientPolledDownloadCondition, isQualityGateEligibleRow } from '../utils/download-state.js';
import type { DownloadClientService } from './download-client.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

/**
 * #2341 AC9. A crash between the insert and the publish leaves a completed, external-id-less row
 * describing a handoff that never reached the watch directory. The spec accepts that residue and
 * states exactly what it does; these assertions are the pin. They run against a real migrated DB
 * because the load-bearing claim is that SQL PREDICATES exclude the row, which a mock cannot show.
 *
 * Nothing here asserts recovery: no test may depend on anything re-grabbing the book, because the
 * spec makes no such claim (scheduled search and RSS are both settings-gated).
 */
describe('Crash residue: a completed handoff row whose artifact was never published (#2341)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;

  const MAGNET = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crash-residue-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    bookService = new BookService(db, inject<FastifyBaseLogger>(log));
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libSQL may retain Windows handles; cleanup is best-effort.
    }
  });

  async function seedResidue(): Promise<{ bookId: number; row: typeof downloads.$inferSelect }> {
    const book = await bookService.create({ title: 'The Stranger', authors: [{ name: 'Albert Camus' }], status: 'wanted' });
    const [row] = await db
      .insert(downloads)
      .values({
        publicId: 'dl_residue0000000000000',
        bookId: book.id,
        title: 'The Stranger (Unabridged)',
        protocol: 'torrent',
        downloadUrl: MAGNET,
        clientStatus: 'completed',
        pipelineStage: 'idle',
        progress: 1,
        completedAt: new Date(),
        externalId: null,
      })
      .returning();
    return { bookId: book.id, row: row! };
  }

  it('is not even gathered as a blocker, and classifies the book as clear', async () => {
    const { bookId } = await seedResidue();

    const blockers = await gatherBookBlockers(db, bookId);

    expect(blockers.replaceable).toEqual([]);
    expect(blockers.pipelineDownloads).toEqual([]);
    expect(classifyBlockers(blockers)).toEqual({ kind: 'clear' });
  });

  it('is neither quality-gate eligible nor a pipeline blocker in memory', async () => {
    const { row } = await seedResidue();

    expect(isQualityGateEligibleRow(row)).toBe(false);
    expect(isPipelineBlocker(row)).toBe(false);
  });

  it('is not returned by the monitor poll query', async () => {
    await seedResidue();

    const polled = await db.select().from(downloads).where(clientPolledDownloadCondition());

    expect(polled).toEqual([]);
  });

  it('does not block a fresh grab for the same book', async () => {
    const { bookId } = await seedResidue();
    const [client] = await db.insert(downloadClients).values({ name: 'Blackhole', type: 'blackhole', settings: {} }).returning();
    const stageDownload = vi.fn().mockResolvedValue({ commit: vi.fn().mockResolvedValue(undefined), abort: vi.fn() });
    const clientService = inject<DownloadClientService>({
      getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: client!.id, name: 'Blackhole', type: 'blackhole', settings: {} }),
      getAdapter: vi.fn().mockResolvedValue({ stageDownload, addDownload: vi.fn(), removeDownload: vi.fn() }),
    });
    const service = new DownloadService(db, clientService, inject<FastifyBaseLogger>(log));

    const grabbed = await service.grab({ downloadUrl: MAGNET, title: 'The Stranger (Unabridged)', bookId, skipDuplicateCheck: false });

    expect(grabbed.id).toBeGreaterThan(0);
    expect(stageDownload).toHaveBeenCalledTimes(1);
    await expect(service.grab({ downloadUrl: MAGNET, title: 'Retry', bookId, skipDuplicateCheck: false }))
      .resolves.toBeDefined();
  });

  it('rejects the same grab once a tracked download is what exists instead — the exclusion is the null id, not the completed status', async () => {
    const { bookId } = await seedResidue();
    await db.insert(downloads).values({
      publicId: 'dl_tracked00000000000000',
      bookId,
      title: 'The Stranger (Unabridged)',
      protocol: 'torrent',
      downloadUrl: MAGNET,
      clientStatus: 'completed',
      pipelineStage: 'idle',
      progress: 1,
      completedAt: new Date(),
      externalId: 'ext-42',
    });
    const service = new DownloadService(db, inject<DownloadClientService>({}), inject<FastifyBaseLogger>(log));

    await expect(service.grab({ downloadUrl: MAGNET, title: 'Retry', bookId, skipDuplicateCheck: false }))
      .rejects.toBeInstanceOf(DuplicateDownloadError);
  });
});
