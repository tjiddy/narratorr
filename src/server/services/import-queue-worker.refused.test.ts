import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, importJobs, bookEvents } from '../../db/schema.js';
import { BookService, OwnedRecordingError } from './book.service.js';
import { ImportQueueWorker } from './import-queue-worker.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { ImportAdapter } from './import-adapters/types.js';
import type { EventHistoryService } from './event-history.service.js';
import { importFailedPayload } from '../../shared/schemas/sse-events.js';

const noopLog: FastifyBaseLogger = {
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  level: 'info', silent: vi.fn(),
} as unknown as FastifyBaseLogger;

// #1736 — DB-backed worker-level regression guard for the forced-import refused terminal disposition.
//
// The copy-time collision fence refuses a forced import by throwing `OwnedRecordingError`. The
// adapter rethrows it (it stops translating the typed error into a generic failure — covered in
// manual.test.ts), and `ImportQueueWorker.processJob` must branch on it BEFORE the generic
// `markJobFailed` path. This file drives a real adapter-rethrow through the real worker against a
// migrated DB so the placeholder-deletion + FK-nulling + enriched event/SSE contract is exercised
// end-to-end — an adapter-only test can pass while the worker still emits the generic failed path.
describe('ImportQueueWorker — forced-import refused terminal disposition (#1736, DB-backed)', () => {
  let dir: string;
  let db: Db;
  let bookService: BookService;
  let emitSpy: ReturnType<typeof vi.fn>;
  let eventCreate: ReturnType<typeof vi.fn>;
  let eventHistory: EventHistoryService;
  let worker: ImportQueueWorker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iqw-refused-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    bookService = new BookService(db, noopLog);
    clearImportAdapters();
    emitSpy = vi.fn();
    eventCreate = vi.fn().mockResolvedValue({});
    eventHistory = { create: eventCreate } as unknown as EventHistoryService;
    worker = new ImportQueueWorker(db, noopLog, { emit: emitSpy } as never, undefined, eventHistory);
  });

  afterEach(async () => {
    await worker.stop();
    clearImportAdapters();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep handles on Windows — best effort
    }
  });

  /** Seed an `importing` placeholder book + a pending manual job linked to it. */
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

  /** Seed an `importing` placeholder + a pending manual job WITHOUT `forceImport` (the F1 case). */
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

  /** Register a manual adapter that rethrows the given OwnedRecordingError (as the real adapter does). */
  function registerRefusingAdapter(error: OwnedRecordingError): void {
    const adapter: ImportAdapter = {
      type: 'manual',
      async process() { throw error; },
    };
    registerImportAdapter(adapter);
  }

  /** Drive one drain cycle to completion. */
  async function runWorker(): Promise<void> {
    await worker.start();
    await new Promise(r => setTimeout(r, 150));
    await worker.stop();
  }

  it('single-owner review refusal: job failed, placeholder deleted, FK nulled, enriched event + SSE', async () => {
    const { bookId, jobId } = await seedForcedJob();
    registerRefusingAdapter(new OwnedRecordingError({ existingBookId: 99, title: 'Owned', reason: 'recording-review' }));

    await runWorker();

    // Job → terminal failed/failed (NOT completed); lastError carries the structured refusal.
    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    expect(jobRow!.phase).toBe('failed');
    const parsedErr = JSON.parse(jobRow!.lastError!);
    expect(parsedErr.refusal).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review', existingBookId: 99 });

    // Placeholder book deleted — no orphan importing/failed row.
    const remaining = await db.select().from(books).where(eq(books.id, bookId));
    expect(remaining).toHaveLength(0);

    // Post-delete FK linkage: import_jobs.book_id nulled by `onDelete: set null`.
    expect(jobRow!.bookId).toBeNull();

    // Enriched durable event on the import_failed channel; bookId null (placeholder gone), title preserved.
    expect(eventCreate).toHaveBeenCalledTimes(1);
    const eventArg = eventCreate.mock.calls[0]![0];
    expect(eventArg).toMatchObject({
      bookId: null,
      bookTitle: 'Forced Book',
      eventType: 'import_failed',
      source: 'manual',
    });
    expect(eventArg.reason.refusal).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review', existingBookId: 99 });

    // SSE import_failed: pre-delete placeholder book_id (so the client evicts the card), structured
    // refusal reason, and a non-generic error_message. Validates against the SSE schema.
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
    // NOT the generic import_complete success path.
    expect(emitSpy.mock.calls.some(c => c[0] === 'import_complete')).toBe(false);
  });

  it('2+-owner data anomaly stays fail-closed under force: refused disposition, no swap/overwrite', async () => {
    const { bookId, jobId } = await seedForcedJob();
    registerRefusingAdapter(new OwnedRecordingError({ existingBookId: 5, title: 'Owned', reason: 'recording-review-ambiguous-owner' }));

    await runWorker();

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    const remaining = await db.select().from(books).where(eq(books.id, bookId));
    expect(remaining).toHaveLength(0);
    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review-ambiguous-owner', existingBookId: 5 });
  });

  it('ownerless refusal (-1 sentinel) reports existingBookId null, never "book #-1"', async () => {
    const { jobId } = await seedForcedJob();
    registerRefusingAdapter(new OwnedRecordingError({ existingBookId: -1, title: 'New Recording', reason: 'recording-review-no-disambiguator' }));

    await runWorker();

    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toMatchObject({ kind: 'forced-import-refused', recordingReason: 'recording-review-no-disambiguator', existingBookId: null });
    expect(payload.error_message).not.toContain('#-1');
    expect(payload.error_message).toContain('no identifiable owner');
    void jobId;
  });

  it('F1 — NON-forced OwnedRecordingError takes the generic path, NOT the forced-refused disposition', async () => {
    // The copy-time collision fence is force-independent, so a non-forced import can also throw
    // OwnedRecordingError. That was never user-forced — it must settle as a generic failure (book
    // reverts to `failed`, survives; no structured refusal reason; no worker-recorded event), never
    // a `forced-import-refused` disposition with a deleted placeholder.
    const { bookId, jobId } = await seedNonForcedJob();
    registerRefusingAdapter(new OwnedRecordingError({ existingBookId: 99, title: 'Owned', reason: 'recording-review' }));

    await runWorker();

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    expect(jobRow!.phase).toBe('failed');
    // Generic path: lastError carries NO structured refusal discriminator.
    expect(JSON.parse(jobRow!.lastError!).refusal).toBeUndefined();
    // Placeholder NOT deleted — it reverts importing → failed and survives, keeping its FK link.
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow).toBeDefined();
    expect(bookRow!.status).toBe('failed');
    expect(jobRow!.bookId).toBe(bookId);
    // SSE import_failed without a structured refusal reason; no worker-recorded refusal event.
    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toBeUndefined();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it('non-Owned failure is unchanged: generic markJobFailed path, book reverts to failed (not deleted)', async () => {
    const { bookId, jobId } = await seedForcedJob();
    const adapter: ImportAdapter = { type: 'manual', async process() { throw new Error('disk full'); } };
    registerImportAdapter(adapter);

    await runWorker();

    const [jobRow] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    expect(jobRow!.status).toBe('failed');
    // Generic path: the book is NOT deleted — it transitions importing → failed and survives.
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    expect(bookRow).toBeDefined();
    expect(bookRow!.status).toBe('failed');
    // No structured refusal reason on a generic failure SSE.
    const payload = emitSpy.mock.calls.find(c => c[0] === 'import_failed')![1];
    expect(payload.refusal_reason).toBeUndefined();
    expect(payload.error_message).toContain('disk full');
    // The worker did not record a refused event for a generic failure (that event is the adapter's).
    expect(eventCreate).not.toHaveBeenCalled();
    // FK still nulled? No — the book survives, so the job keeps its link.
    expect(jobRow!.bookId).toBe(bookId);
    // Sanity: no bookEvents written by the worker on the generic path.
    const events = await db.select().from(bookEvents);
    expect(events).toHaveLength(0);
  });
});
