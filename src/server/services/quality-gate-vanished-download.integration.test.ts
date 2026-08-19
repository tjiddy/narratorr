import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookEvents, downloads } from '@db/schema.js';
import { BookService } from './book.service.js';
import { EventHistoryService } from './event-history.service.js';
import { QualityGateService } from './quality-gate.service.js';
import { QualityGateOrchestrator } from './quality-gate-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import { createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';

const VANISHED_DOWNLOAD_ID = 113;
const VANISHED_REASON = 'Download row disappeared before the quality gate could evaluate it';

// AC5 turns entirely on the book_events FKs: a stale book id makes the insert fail and the helper's
// `.catch` swallows it, so a mocked event service cannot distinguish "deliberately skipped" from
// "silently rejected". These cases therefore run against a real migrated DB.
describe('Quality gate: download row vanished before evaluation (#2307, DB-backed)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let eventHistory: EventHistoryService;
  let createSpy: MockInstance<EventHistoryService['create']>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'qg-vanished-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    bookService = new BookService(db, inject<FastifyBaseLogger>(log));
    eventHistory = new EventHistoryService(db, inject<FastifyBaseLogger>(log), inject<BlacklistService>({}), bookService);
    createSpy = vi.spyOn(eventHistory, 'create');
  });

  afterEach(() => {
    createSpy.mockRestore();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may retain Windows handles; cleanup is best-effort.
    }
  });

  function createOrchestrator(handle: Db = db): QualityGateOrchestrator {
    const orchestrator = new QualityGateOrchestrator(
      new QualityGateService(handle, inject<FastifyBaseLogger>(log)),
      handle,
      inject<FastifyBaseLogger>(log),
      inject<DownloadClientService>({ getAdapter: vi.fn().mockResolvedValue(null) }),
      { eventHistory },
    );
    orchestrator.wire({ nudgeImportWorker: vi.fn(), bookImportService: {} as never });
    return orchestrator;
  }

  async function seedBook(): Promise<number> {
    const book = await bookService.create({ title: 'The Stranger', authors: [{ name: 'Albert Camus' }], status: 'downloading' });
    return book.id;
  }

  function errorRecord(): Record<string, unknown> {
    expect(log.error).toHaveBeenCalledTimes(1);
    return (log.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
  }

  /**
   * `recordDownloadFailedEvent` detaches `eventHistory.create` and `processOneDownload` resolves
   * without it, so flushing a turn only guesses at the libSQL round trip. The spy records the write
   * itself: awaiting it settles the insert with no timeout, and is a no-op resolve on the branches
   * that correctly issue none. `allSettled` because a rejected insert is a row assertion's job to
   * catch, not this helper's.
   */
  async function settleEventWrites(): Promise<void> {
    await Promise.allSettled(createSpy.mock.results.map((result) => result.value));
  }

  it('live book: persists one download_failed row keyed to the book, with a NULL download id', async () => {
    const bookId = await seedBook();

    await createOrchestrator().processOneDownload(VANISHED_DOWNLOAD_ID, {
      bookId, releaseTitle: 'The Stranger [2026] [MP3-64]',
    });
    // Anchors the settle above: without a recorded write there is nothing to await, and a
    // zero-row result below would be indistinguishable from an insert that never happened.
    expect(createSpy).toHaveBeenCalledTimes(1);
    await settleEventWrites();

    const rows = await db.select().from(bookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'download_failed',
      bookId,
      // The book's own title — the polled release title would satisfy a weaker assertion.
      bookTitle: 'The Stranger',
      downloadId: null,
      source: 'auto',
      reason: { error: VANISHED_REASON },
    });
    expect(errorRecord()).toEqual({ downloadId: VANISHED_DOWNLOAD_ID, bookId, bookTitle: 'The Stranger' });
  });

  it('book concurrently deleted: no event is even attempted, and the log says so', async () => {
    const bookId = await seedBook();
    await db.delete(books).where(eq(books.id, bookId));

    await createOrchestrator().processOneDownload(VANISHED_DOWNLOAD_ID, {
      bookId, releaseTitle: 'The Stranger [2026]',
    });
    await settleEventWrites();

    expect(await db.select().from(bookEvents)).toHaveLength(0);
    // Row-counting alone would also pass against an implementation whose FK-rejected insert
    // was swallowed; the no-call assertion is what rules that out.
    expect(createSpy).not.toHaveBeenCalled();
    expect(errorRecord()).toEqual({
      downloadId: VANISHED_DOWNLOAD_ID, bookId, releaseTitle: 'The Stranger [2026]', bookDeleted: true,
    });
  });

  it('book lookup rejects: no event, the lookup error is serialized, and the call still resolves', async () => {
    const bookId = await seedBook();
    const lookupError = new Error('SQLITE_BUSY: database is locked');
    // Fail only the book title lookup — it is the sole select projecting exactly `title`.
    const failingHandle = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'select') return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          const projection = args[0];
          const keys = projection && typeof projection === 'object' ? Object.keys(projection) : [];
          if (keys.length === 1 && keys[0] === 'title') return mockDbChain([], { error: lookupError });
          return (target.select as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as Db;

    await expect(createOrchestrator(failingHandle).processOneDownload(VANISHED_DOWNLOAD_ID, {
      bookId, releaseTitle: 'The Stranger [2026]',
    })).resolves.toBeUndefined();
    await settleEventWrites();

    expect(await db.select().from(bookEvents)).toHaveLength(0);
    expect(createSpy).not.toHaveBeenCalled();
    const record = errorRecord();
    expect(record).toMatchObject({ downloadId: VANISHED_DOWNLOAD_ID, bookId, releaseTitle: 'The Stranger [2026]' });
    const logged = record.error as Record<string, unknown>;
    expect(logged).not.toBeInstanceOf(Error);
    expect(logged.type).toBe('Error');
    expect(logged.message).toBe('SQLITE_BUSY: database is locked');
  });

  it('row still present but no longer completed: the benign race stays a warn with no event', async () => {
    const bookId = await seedBook();
    const [row] = await db.insert(downloads).values({
      publicId: 'dl_checking', title: 'The Stranger [2026]', bookId,
      externalId: 'ext-1', clientStatus: 'completed', pipelineStage: 'checking', progress: 1,
    }).returning({ id: downloads.id });

    await createOrchestrator().processOneDownload(row!.id, { bookId, releaseTitle: 'The Stranger [2026]' });
    await settleEventWrites();

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ downloadId: row!.id }, expect.stringContaining('not found or not completed'));
    expect(await db.select().from(bookEvents)).toHaveLength(0);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('no book provenance: errors on the release title alone and records nothing', async () => {
    await createOrchestrator().processOneDownload(VANISHED_DOWNLOAD_ID, { bookId: null, releaseTitle: 'Orphan Release' });
    await settleEventWrites();

    expect(await db.select().from(bookEvents)).toHaveLength(0);
    expect(createSpy).not.toHaveBeenCalled();
    expect(errorRecord()).toEqual({ downloadId: VANISHED_DOWNLOAD_ID, releaseTitle: 'Orphan Release' });
  });
});
