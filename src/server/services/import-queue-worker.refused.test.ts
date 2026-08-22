import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importJobs, bookEvents } from '@db/schema.js';
import { BookService, OwnedRecordingError } from './book.service.js';
import { ImportQueueWorker } from './import-queue-worker.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { ImportAdapter } from './import-adapters/types.js';
import { EventHistoryService } from './event-history.service.js';
import type { BlacklistService } from './blacklist.service.js';
import { inject } from '../__tests__/helpers.js';
import { importFailedPayload } from '@shared/schemas/sse-events.js';

const noopLog: FastifyBaseLogger = {
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  level: 'info', silent: vi.fn(),
} as unknown as FastifyBaseLogger;

// Drive a real adapter rethrow through the DB-backed worker: forced refusal must bypass generic
// failure, delete its placeholder, null the FK, and emit the structured event/SSE contract.
describe('ImportQueueWorker — forced-import refused terminal disposition (#1736, DB-backed)', () => {
  let dir: string;
  let db: Db;
  let bookService: BookService;
  let emitSpy: ReturnType<typeof vi.fn>;
  let eventHistory: EventHistoryService;
  // Refusal deletes the placeholder, so it must never enqueue reconciliation for that row.
  let reconcileBook: Mock<(bookId: number) => Promise<void>>;
  let worker: ImportQueueWorker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iqw-refused-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    bookService = new BookService(db, noopLog);
    clearImportAdapters();
    emitSpy = vi.fn();
    // The real service against the migrated DB, not a `{ create }` fake: production's tx arm hands
    // the row to a post-commit `logRecorded`, and a partial double turns that into a silently
    // swallowed TypeError while `create`-spy assertions observe issuance, not persistence (#2499).
    eventHistory = new EventHistoryService(db, noopLog, inject<BlacklistService>({}), bookService);
    reconcileBook = vi.fn().mockResolvedValue(undefined);
    worker = new ImportQueueWorker(db, noopLog, { emit: emitSpy } as never, undefined, eventHistory, { reconcileBook });
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

  async function seedForcedJob(): Promise<{ bookId: number; jobId: number }> {
    const book = await bookService.create({ title: 'Forced Book', authors: [{ name: 'Author' }], status: 'importing' });
    const [job] = await db.insert(importJobs).values({
      bookId: book.id,
      type: 'manual',
      status: 'pending',
      phase: 'queued',
      metadata: JSON.stringify({ path: '/dl/Forced Book', title: 'Forced Book', forceImport: true }),
    }).returning();
    return { bookId: book.id, jobId: job!.id };
  }

  async function seedNonForcedJob(): Promise<{ bookId: number; jobId: number }> {
    const book = await bookService.create({ title: 'Plain Book', authors: [{ name: 'Author' }], status: 'importing' });
    const [job] = await db.insert(importJobs).values({
      bookId: book.id,
      type: 'manual',
      status: 'pending',
      phase: 'queued',
      metadata: JSON.stringify({ path: '/dl/Plain Book', title: 'Plain Book' }),
    }).returning();
    return { bookId: book.id, jobId: job!.id };
  }

  /** Resolves once the worker has entered the adapter — the job is claimed by then. */
  function registerAdapter(process: () => Promise<void>): Promise<void> {
    let enter!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const adapter: ImportAdapter = {
      type: 'manual',
      async process() { enter(); return process(); },
    };
    registerImportAdapter(adapter);
    return entered;
  }

  function registerRefusingAdapter(error: OwnedRecordingError): Promise<void> {
    return registerAdapter(async () => { throw error; });
  }

  /**
   * Deterministic settlement, no wall clock (#2508): a fixed sleep lets a delayed scheduler land
   * `stop()` before the claim — `stopping` is set first and drainOne re-checks it after its SELECT,
   * abandoning the job. Once the adapter has been ENTERED the job is claimed (`currentJobPromise`
   * is assigned before `processJob` is awaited), so `stop()` awaits its full completion. The tick
   * drain absorbs post-commit fire-and-forget reporting (SSE) that follows the awaited job.
   */
  async function runWorker(entered: Promise<void>): Promise<void> {
    await worker.start();
    await entered;
    await worker.stop();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it('single-owner review refusal: job failed, placeholder deleted, FK nulled, enriched event + SSE', async () => {
    const { bookId, jobId } = await seedForcedJob();
    const entered = registerRefusingAdapter(new OwnedRecordingError({ existingBookId: 99, title: 'Owned', reason: 'recording-review' }));

    await runWorker(entered);

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    expect(jobRow!.phase).toBe('failed');
    const parsedErr = JSON.parse(jobRow!.lastError!);
    expect(parsedErr.refusal).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review', existingBookId: 99 });

    const remaining = await db.select().from(books).where(eq(books.id, bookId));
    expect(remaining).toHaveLength(0);

    expect(jobRow!.bookId).toBeNull();

    // Persistence, not issuance: the row must be in book_events. Filter by eventType — the
    // refusal deletes the placeholder, so the event links bookId null (#2499).
    const failedEvents = await db.select().from(bookEvents).where(eq(bookEvents.eventType, 'import_failed'));
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      bookId: null,
      bookTitle: 'Forced Book',
      eventType: 'import_failed',
      source: 'manual',
    });
    expect(failedEvents[0]!.reason).toMatchObject({
      refusal: { kind: 'forced-import-refused', recordingReason: 'recording-review', existingBookId: 99 },
    });

    // SSE retains the pre-delete book id so the client can evict the placeholder.
    const failedCalls = emitSpy.mock.calls.filter(c => c[0] === 'import_failed');
    expect(failedCalls).toHaveLength(1);
    const payload = failedCalls[0]![1];
    expect(importFailedPayload.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      job_id: jobId,
      book_id: bookId,
      book_title: 'Forced Book',
      refusal_reason: { kind: 'forced-import-refused', recordingReason: 'recording-review', existingBookId: 99 },
    });
    expect(payload.error_message).toContain('force refused');
    expect(payload.error_message).toContain('#99');
    expect(emitSpy.mock.calls.some(c => c[0] === 'import_complete')).toBe(false);

    expect(reconcileBook).not.toHaveBeenCalled();
  });

  it('2+-owner data anomaly stays fail-closed under force: refused disposition, no swap/overwrite', async () => {
    const { bookId, jobId } = await seedForcedJob();
    const entered = registerRefusingAdapter(new OwnedRecordingError({ existingBookId: 5, title: 'Owned', reason: 'recording-review-ambiguous-owner' }));

    await runWorker(entered);

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    const remaining = await db.select().from(books).where(eq(books.id, bookId));
    expect(remaining).toHaveLength(0);
    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review-ambiguous-owner', existingBookId: 5 });
    expect(reconcileBook).not.toHaveBeenCalled();
  });

  it('ownerless refusal (-1 sentinel) reports existingBookId null, never "book #-1"', async () => {
    const { jobId } = await seedForcedJob();
    const entered = registerRefusingAdapter(new OwnedRecordingError({ existingBookId: -1, title: 'New Recording', reason: 'recording-review-no-disambiguator' }));

    await runWorker(entered);

    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review-no-disambiguator', existingBookId: null });
    expect(payload.error_message).not.toContain('#-1');
    expect(payload.error_message).toContain('no identifiable owner');
    expect(reconcileBook).not.toHaveBeenCalled();
    void jobId;
  });

  it('F1 — NON-forced OwnedRecordingError takes the generic path, NOT the forced-refused disposition', async () => {
    // OwnedRecordingError is force-independent; only forced imports get refusal cleanup.
    // Non-forced imports take generic failure and retain their placeholder.
    const { bookId, jobId } = await seedNonForcedJob();
    const entered = registerRefusingAdapter(new OwnedRecordingError({ existingBookId: 99, title: 'Owned', reason: 'recording-review' }));

    await runWorker(entered);

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    expect(jobRow!.phase).toBe('failed');
    expect(JSON.parse(jobRow!.lastError!).refusal).toBeUndefined();
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow).toBeDefined();
    expect(bookRow!.status).toBe('failed');
    expect(jobRow!.bookId).toBe(bookId);
    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toBeUndefined();
    expect(await db.select().from(bookEvents)).toHaveLength(0);
    expect(reconcileBook).not.toHaveBeenCalled();
  });

  it('non-Owned failure is unchanged: generic markJobFailed path, book reverts to failed (not deleted)', async () => {
    const { bookId, jobId } = await seedForcedJob();
    const entered = registerAdapter(async () => { throw new Error('disk full'); });

    await runWorker(entered);

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow).toBeDefined();
    expect(bookRow!.status).toBe('failed');
    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toBeUndefined();
    expect(payload.error_message).toContain('disk full');
    expect(jobRow!.bookId).toBe(bookId);
    const events = await db.select().from(bookEvents);
    expect(events).toHaveLength(0);
    expect(reconcileBook).not.toHaveBeenCalled();
  });

  // Positive control proves the reconciler spy is live; otherwise every negative assertion is vacuous.
  it('positive control: a SUCCEEDING import on this same worker fires exactly one reconcile', async () => {
    const { bookId, jobId } = await seedForcedJob();
    const entered = registerAdapter(async () => { /* succeeds */ });

    await runWorker(entered);

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('completed');
    expect(reconcileBook).toHaveBeenCalledTimes(1);
    expect(reconcileBook).toHaveBeenCalledWith(bookId);
  });
});
