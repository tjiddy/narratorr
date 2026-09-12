import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, downloadClients, downloads } from '@db/schema.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { BookService } from './book.service.js';
import { DownloadService } from './download.service.js';
import { DownloadOrchestrator } from './download-orchestrator.js';
import { QualityGateService } from './quality-gate.service.js';
import { QualityGateOrchestrator } from './quality-gate-orchestrator.js';
import { RetryBudget } from './retry-budget.js';
import { ImportService } from './import.service.js';
import { ImportOrchestrator } from './import-orchestrator.js';
import { transitionDownloadState } from '../utils/download-state.js';
import { monitorDownloads } from '../jobs/monitor.js';
import { retrySearch } from './retry-search.js';
import type { DownloadClientService } from './download-client.service.js';
import type { NotifierService } from './notifier.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService as BookServiceType } from './book.service.js';
import { createMockLogger, createMockSettingsService, inject, mockSearchAllWithStatus } from '../__tests__/helpers.js';

/**
 * #2622 AC8 against a real migrated database. The load-bearing claim is about a PERSISTED column:
 * a chain mock records that a statement was issued, not what a later revert reads back. So the
 * failure, the retry grab, the replacement insert and the revert all run against real SQL here.
 *
 * The AC8 cases drive the monitor, because that is the production producer of the drift — the
 * failure arm blacklists and retries before any book-status recovery, so the retry grab used to read
 * `books.status` while the failed download still owned it. The last block drives `retrySearch`
 * directly, which is the shape of the two detached producers that have no snapshot to plumb.
 */
describe('fail → retry → revert, against a migrated DB (#2622)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let downloadService: DownloadService;
  let orchestrator: DownloadOrchestrator;
  let adapter: { getDownload: ReturnType<typeof vi.fn>; addDownload: ReturnType<typeof vi.fn>; removeDownload: ReturnType<typeof vi.fn> };
  let clientService: DownloadClientService;
  let broadcaster: { emit: ReturnType<typeof vi.fn> };
  let retryDeps: unknown;

  const FIRST = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
  const REPLACEMENT = {
    title: 'Cujo (Unabridged) [MP3 64kbps]',
    protocol: 'torrent' as const,
    downloadUrl: 'magnet:?xt=urn:btih:bbf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    infoHash: 'bbf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    size: 500_000_000,
    seeders: 12,
    indexer: 'TestIndexer',
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'retry-status-drift-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    bookService = new BookService(db, inject<FastifyBaseLogger>(log));
    broadcaster = { emit: vi.fn() };

    const [client] = await db.insert(downloadClients).values({ name: 'qBit', type: 'qbittorrent', settings: {} }).returning();
    adapter = {
      getDownload: vi.fn(),
      addDownload: vi.fn().mockImplementation((artifact: { url?: string }) => Promise.resolve(`ext-${String(artifact.url ?? '').slice(-6)}`)),
      removeDownload: vi.fn().mockResolvedValue(undefined),
    };
    clientService = inject<DownloadClientService>({
      getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: client!.id, name: 'qBit', type: 'qbittorrent', settings: {} }),
      getAdapter: vi.fn().mockResolvedValue(adapter),
    });

    downloadService = new DownloadService(db, clientService, inject<FastifyBaseLogger>(log));
    orchestrator = new DownloadOrchestrator(
      downloadService, db, inject<FastifyBaseLogger>(log),
      undefined,
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
      inject<EventBroadcasterService>(broadcaster),
    );

    retryDeps = {
      blacklistService: inject<BlacklistService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
      retrySearchDeps: {
        indexerSearchService: inject<IndexerSearchService>({ searchAllWithStatus: mockSearchAllWithStatus([REPLACEMENT]) }),
        indexerService: inject<IndexerService>({ getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }) }),
        downloadOrchestrator: orchestrator,
        blacklistService: inject<BlacklistService>({
          getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
          getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
        }),
        bookService: inject<BookServiceType>({ getById: vi.fn().mockImplementation((id: number) => bookService.getById(id)) }),
        settingsService: createMockSettingsService(),
        retryBudget: new RetryBudget(),
        eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
        log: inject<FastifyBaseLogger>(createMockLogger()),
      },
    };
  });

  afterEach(() => {
    // libSQL keeps the file open on Windows until the client closes (#2599).
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  const bookStatus = async (bookId: number): Promise<BookStatus> => {
    const [row] = await db.select({ status: books.status }).from(books).where(eq(books.id, bookId)).limit(1);
    return row!.status as BookStatus;
  };

  /**
   * Seed a book at `status`, grab through the orchestrator (so the first capture is production's),
   * then drive one monitor cycle where the client reports the download errored. The monitor
   * blacklists, retries, grabs the replacement and deletes the failed row.
   */
  async function failAndRetry(status: BookStatus): Promise<{ bookId: number; replacement: typeof downloads.$inferSelect }> {
    const book = await bookService.create({ title: 'Cujo', authors: [{ name: 'Stephen King' }], status });
    const first = await orchestrator.grab({ downloadUrl: FIRST, title: 'Cujo (Unabridged)', bookId: book.id, protocol: 'torrent' });

    adapter.getDownload.mockResolvedValue({ progress: 0, status: 'error', savePath: '', name: 'Cujo', size: 0, errorMessage: 'Repair failed' });
    await monitorDownloads(
      db, clientService,
      inject<NotifierService>({ notify: vi.fn().mockResolvedValue(undefined) }),
      inject<FastifyBaseLogger>(log),
      retryDeps as never,
      inject<EventBroadcasterService>(broadcaster),
    );

    const rows = await db.select().from(downloads);
    expect(rows.map((r) => r.id)).not.toContain(first.id);
    expect(rows).toHaveLength(1);
    return { bookId: book.id, replacement: rows[0]! };
  }

  it('persists the NORMALIZED capture on the replacement row, read back through Drizzle', async () => {
    const { replacement } = await failAndRetry('wanted');

    // Pre-fix this column read 'downloading' — the book's live status at the moment of the retry grab.
    expect(replacement.bookStatusAtGrab).toBe('wanted');
    expect(replacement.infoHash).toBe(REPLACEMENT.infoHash);
  });

  it('fail → retry → cancel leaves the book wanted, not downloading', async () => {
    const { bookId, replacement } = await failAndRetry('wanted');
    expect(await bookStatus(bookId)).toBe('downloading');

    await expect(orchestrator.cancel(replacement.id)).resolves.toBe(true);

    expect(await bookStatus(bookId)).toBe('wanted');
  });

  /**
   * Both consumers of the persisted column on this path run for real: `ImportService` reverts the
   * book through `handleImportFailure`, and `ImportOrchestrator.dispatchFailureSideEffects` puts the
   * same snapshot on the wire. Asserting the emitted event rather than re-deriving
   * `bookStatusAtGrab ?? REVERT_FALLBACK_STATUS` in the test is what makes deleting or re-arguing
   * `emitImportFailure` (`import-orchestrator.ts:284`) visible here.
   *
   * The failure is a vanished client item — the shape of the City of Ashes #3161 incident — and
   * deliberately a plain `Error`: a `ContentFailureError` would instead fire the detached
   * blacklist-and-research arm and grab a second replacement mid-assertion.
   */
  it('fail → retry → import failure reverts the book AND emits the normalized revertedBookStatus', async () => {
    const { bookId, replacement } = await failAndRetry('wanted');

    const settingsService = createMockSettingsService();
    const importService = new ImportService(db, clientService, settingsService, inject<FastifyBaseLogger>(log), undefined, bookService);
    const importOrchestrator = new ImportOrchestrator(
      importService, settingsService, inject<FastifyBaseLogger>(log),
      undefined, undefined,
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
      inject<EventBroadcasterService>(broadcaster),
      undefined, bookService,
    );

    adapter.getDownload.mockResolvedValue(null);
    broadcaster.emit.mockClear();

    await expect(importOrchestrator.importDownload(replacement.id)).rejects.toThrow(/not found in client/);

    expect(await bookStatus(bookId)).toBe('wanted');
    // `old_status: 'importing'` separates the failure emission from the entry one, which carries
    // `new_status: 'importing'`. `new_status` IS the revertedBookStatus argument.
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
      book_id: bookId,
      old_status: 'importing',
      new_status: 'wanted',
    });
    // A null column is the only input that degrades this event to REVERT_FALLBACK_STATUS, and AC2
    // forbids the retry path from persisting one.
    expect(replacement.bookStatusAtGrab).toBe('wanted');
  });

  it('fail → retry → quality-gate reject reverts to the normalized capture', async () => {
    const { bookId, replacement } = await failAndRetry('wanted');
    await transitionDownloadState(db, replacement.id, { clientStatus: 'completed', pipelineStage: 'pending_review', progress: 1 });

    const qgOrchestrator = new QualityGateOrchestrator(
      new QualityGateService(db, inject<FastifyBaseLogger>(log)),
      db,
      inject<FastifyBaseLogger>(log),
      clientService,
      { broadcaster: inject<EventBroadcasterService>(broadcaster) },
    );

    await expect(qgOrchestrator.reject(replacement.id)).resolves.toMatchObject({ status: 'failed' });

    expect(await bookStatus(bookId)).toBe('wanted');
  });

  it('genuine operator intent survives end to end — a missing book reverts to missing, not wanted', async () => {
    const { bookId, replacement } = await failAndRetry('missing');

    expect(replacement.bookStatusAtGrab).toBe('missing');
    await orchestrator.cancel(replacement.id);
    expect(await bookStatus(bookId)).toBe('missing');
  });

  /**
   * The rejection helper and mark-failed reach `retrySearch` with no snapshot to offer, two of them
   * DETACHED from the `revertBookStatus` on the next lines. Neither ordering of that race may
   * capture a transient value — which is why AC5's policy covers the read arm too, not just the
   * plumbed one. Driving `retrySearch` directly with the book parked at each status reproduces both
   * sides: "the retry read first" and "the revert landed first".
   */
  describe('the read arm decides the detached producers, in both orderings (AC5)', () => {
    async function retryWithBookAt(status: BookStatus): Promise<typeof downloads.$inferSelect> {
      const book = await bookService.create({ title: 'Carrion Comfort', authors: [{ name: 'Dan Simmons' }], status });
      const deps = (retryDeps as { retrySearchDeps: Parameters<typeof retrySearch>[1] }).retrySearchDeps;

      await expect(retrySearch(book.id, deps)).resolves.toMatchObject({ outcome: 'retried' });

      const rows = await db.select().from(downloads).where(eq(downloads.bookId, book.id));
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    // 'downloading' is the reject race (retry read before the revert landed); 'importing' is the
    // import-failure race; 'wanted' is mark-failed, which writes the revert first.
    it.each(['downloading', 'importing', 'searching', 'wanted'] as const)(
      'a retry read while the book sits at %s records wanted',
      async (status) => {
        expect((await retryWithBookAt(status)).bookStatusAtGrab).toBe('wanted');
      },
    );

    it('the mirror ordering still preserves a non-transient reverted status', async () => {
      expect((await retryWithBookAt('missing')).bookStatusAtGrab).toBe('missing');
    });
  });
});
