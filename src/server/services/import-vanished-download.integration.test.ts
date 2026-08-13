import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookEvents, downloads, importJobs } from '@db/schema.js';
import { BookService } from './book.service.js';
import { EventHistoryService } from './event-history.service.js';
import { ImportService } from './import.service.js';
import { ImportOrchestrator } from './import-orchestrator.js';
import { ImportQueueWorker } from './import-queue-worker.js';
import { AutoImportAdapter } from './import-adapters/auto.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { NotifierService } from './notifier.service.js';
import type { SettingsService } from './settings.service.js';
import { inject } from '../__tests__/helpers.js';

const noopLog: FastifyBaseLogger = {
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  level: 'info', silent: vi.fn(),
} as unknown as FastifyBaseLogger;

// The #2307 incident, replayed against a real migrated DB: an auto import job whose download row is
// already gone. The FKs on book_events are what these assertions turn on, so a mocked event service
// could not tell a persisted row from a silently rejected insert.
describe('Auto import of a vanished download row (#2307, DB-backed)', () => {
  let dir: string;
  let db: Db;
  let bookService: BookService;
  let eventHistory: EventHistoryService;
  let worker: ImportQueueWorker;
  let emitSpy: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;

  const VANISHED_DOWNLOAD_ID = 113;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-vanished-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    clearImportAdapters();

    bookService = new BookService(db, noopLog);
    eventHistory = new EventHistoryService(db, noopLog, inject<BlacklistService>({}), bookService);
    emitSpy = vi.fn();
    notify = vi.fn().mockResolvedValue(undefined);

    const settingsService = inject<SettingsService>({ get: vi.fn().mockResolvedValue({}) });
    const importService = new ImportService(
      db, inject<DownloadClientService>({}), settingsService, noopLog, undefined, bookService,
    );
    const orchestrator = new ImportOrchestrator(
      importService, settingsService, noopLog,
      inject<NotifierService>({ notify }), undefined, eventHistory,
      inject<EventBroadcasterService>({ emit: emitSpy }), undefined, bookService,
    );
    registerImportAdapter(new AutoImportAdapter(orchestrator));

    worker = new ImportQueueWorker(db, noopLog, inject<EventBroadcasterService>({ emit: emitSpy }), undefined, eventHistory);
  });

  afterEach(async () => {
    await worker.stop();
    clearImportAdapters();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may retain Windows handles; cleanup is best-effort.
    }
  });

  async function seedJob(status: 'importing' | 'wanted' = 'importing'): Promise<{ bookId: number; jobId: number }> {
    const book = await bookService.create({ title: 'The Stranger', authors: [{ name: 'Albert Camus' }], status });
    const [job] = await db.insert(importJobs).values({
      bookId: book.id,
      type: 'auto',
      status: 'pending',
      phase: 'queued',
      metadata: JSON.stringify({ downloadId: VANISHED_DOWNLOAD_ID }),
    }).returning();
    return { bookId: book.id, jobId: job!.id };
  }

  async function runWorker(): Promise<void> {
    await worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop();
  }

  /** The history write is detached from job processing, so drain alone does not settle it. */
  async function awaitEvent(bookId: number): Promise<typeof bookEvents.$inferSelect> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await db.select().from(bookEvents).where(eq(bookEvents.bookId, bookId));
      const row = rows.find((r) => r.eventType === 'import_failed');
      if (row) return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no import_failed event persisted for book ${bookId}`);
  }

  it('persists an import_failed event carrying the book and a NULL download id', async () => {
    const { bookId } = await seedJob();

    await runWorker();

    const event = await awaitEvent(bookId);
    expect(event.bookId).toBe(bookId);
    expect(event.bookTitle).toBe('The Stranger');
    expect(event.downloadId).toBeNull();
    expect(event.source).toBe('auto');
    expect(event.reason).toEqual({ error: `Download ${VANISHED_DOWNLOAD_ID} not found` });
  });

  // Counterfactual for the assertion above: with the vanished id the insert violates the
  // book_events.download_id FK and nothing lands, so `downloadId: null` is load-bearing, not cosmetic.
  it('the same event carrying the vanished download id cannot be persisted at all', async () => {
    const { bookId } = await seedJob();

    const rejection = await eventHistory.create({
      bookId, bookTitle: 'The Stranger', downloadId: VANISHED_DOWNLOAD_ID,
      eventType: 'import_failed', source: 'auto', reason: { error: 'x' },
    }).then(() => null, (err: unknown) => err as Error);
    // Drizzle wraps the driver error, so the constraint name lives on the cause.
    expect(String(rejection?.cause ?? rejection?.message)).toMatch(/FOREIGN KEY/i);

    const rows = await db.select().from(bookEvents).where(eq(bookEvents.bookId, bookId));
    expect(rows).toHaveLength(0);
  });

  it('fails the job, records the original error, and leaves the book failed', async () => {
    const { bookId, jobId } = await seedJob();

    await runWorker();

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    // The degraded dispatch never replaces the context error the caller saw.
    expect(JSON.parse(jobRow!.lastError!).message).toBe(`Download ${VANISHED_DOWNLOAD_ID} not found`);

    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow!.status).toBe('failed');
  });

  // AC6: the guarded transition observed at its own commit point, not at some later monitor pass.
  it('leaves a book that is no longer importing exactly as the earlier path left it', async () => {
    const { bookId } = await seedJob('wanted');

    await runWorker();

    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow!.status).toBe('wanted');
  });

  it('emits exactly one import_failed SSE, with the resolved title rather than Unknown', async () => {
    const { bookId, jobId } = await seedJob();

    await runWorker();

    const failures = emitSpy.mock.calls.filter(([type]) => type === 'import_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]![1]).toMatchObject({
      job_id: jobId,
      book_id: bookId,
      book_title: 'The Stranger',
      error_message: `Download ${VANISHED_DOWNLOAD_ID} not found`,
    });
  });

  it('notifies on_failure naming the book, since the release title died with the row', async () => {
    await seedJob();

    await runWorker();

    expect(notify).toHaveBeenCalledWith('on_failure', {
      event: 'on_failure',
      book: { title: 'The Stranger' },
      error: { message: `Download ${VANISHED_DOWNLOAD_ID} not found`, stage: 'import' },
    });
  });

  // The arm is chosen by which call threw, not by the message — so every context-resolution
  // failure takes it, not only the vanished-row one.
  it('a download row that exists but has no linked book takes the same degraded path', async () => {
    const { bookId } = await seedJob();
    const [row] = await db.insert(downloads).values({
      publicId: 'dl_unlinked', title: 'The Stranger [2026]', bookId: null,
      externalId: 'ext-1', clientStatus: 'completed', pipelineStage: 'idle', progress: 1,
    }).returning({ id: downloads.id });
    await db.update(importJobs).set({ metadata: JSON.stringify({ downloadId: row!.id }) }).where(eq(importJobs.bookId, bookId));

    await runWorker();

    const event = await awaitEvent(bookId);
    expect(event.downloadId).toBeNull();
    expect(event.reason).toEqual({ error: `Download ${row!.id} has no linked book` });
  });

  // The incident's exact ordering: the gate saw a live row, enqueued, then the row went away.
  it('a row deleted between enqueue and drain still lands the full failure disposition', async () => {
    const { bookId, jobId } = await seedJob();
    const [row] = await db.insert(downloads).values({
      publicId: 'dl_racing', title: 'The Stranger [2026]', bookId,
      externalId: 'ext-1', clientStatus: 'completed', pipelineStage: 'idle', progress: 1,
    }).returning({ id: downloads.id });
    await db.update(importJobs).set({ metadata: JSON.stringify({ downloadId: row!.id }) }).where(eq(importJobs.id, jobId));
    await db.delete(downloads).where(eq(downloads.id, row!.id));

    await runWorker();

    const event = await awaitEvent(bookId);
    expect(event.downloadId).toBeNull();
    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow!.status).toBe('failed');
  });

  it('a rejecting history write still commits the job failure and the book transition', async () => {
    const { bookId, jobId } = await seedJob();
    const createSpy = vi.spyOn(eventHistory, 'create').mockRejectedValue(new Error('event insert failed'));

    await runWorker();

    expect(createSpy).toHaveBeenCalled();
    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow!.status).toBe('failed');
    createSpy.mockRestore();
  });

  it('a book deleted after the job was read records no event but still fails the job cleanly', async () => {
    const { bookId, jobId } = await seedJob();
    // import_jobs.book_id is ON DELETE set null, so the worker's in-memory copy outlives the row.
    await db.delete(books).where(eq(books.id, bookId));

    await runWorker();

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    expect(await db.select().from(bookEvents)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
