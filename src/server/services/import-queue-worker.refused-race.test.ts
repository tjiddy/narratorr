import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookAuthors, bookEvents, bookNarrators, importJobs } from '@db/schema.js';
import { importFailedPayload } from '@shared/schemas/sse-events.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const hoisted = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../utils/cover-cache.js', () => ({
  preserveBookCover: vi.fn().mockResolvedValue(undefined),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
}));

/**
 * The real lock still runs; the wrapper only observes. `acquire` is pushed at REQUEST time,
 * `held` at GRANT time, `release` in the finally — a correct waiter's `acquire` therefore
 * precedes the incumbent's `release`, so only `held` may carry a grant-ordering assertion.
 */
vi.mock('./book-admission.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-admission.js')>();
  return {
    ...actual,
    withBookAdmissionLock: vi.fn(async (bookId: number, fn: () => Promise<unknown>) => {
      hoisted.events.push(`lock.acquire:${bookId}`);
      return actual.withBookAdmissionLock(bookId, async () => {
        hoisted.events.push(`lock.held:${bookId}`);
        try {
          return await fn();
        } finally {
          hoisted.events.push(`lock.release:${bookId}`);
        }
      });
    }),
  };
});

import { BookService, OwnedRecordingError } from './book.service.js';
import { BookDeletionService } from './book-deletion.service.js';
import { EventHistoryService } from './event-history.service.js';
import { ImportQueueWorker } from './import-queue-worker.js';
import { finalizeForcedImportRefusal, type RefusedDispositionDeps } from './import-refused.js';
import { hasPendingBookAdmission, withBookAdmissionLock } from './book-admission.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { ImportAdapter } from './import-adapters/types.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

/**
 * #2481. The forced-refusal finalizer used to delete the `importing` placeholder with no admission
 * acquisition, so a mutator queued behind the import could have its committed edit silently deleted
 * — or survive while the "placeholder removed" signal still fired.
 *
 * Every case parks its contender BEFORE it opens a transaction. `db.transaction` is shadowed at the
 * connection and registers on the serialized tail synchronously at call time, so a contender parked
 * mid-transaction would order the finalizer through that inner tier and keep these cases green with
 * the admission wrapper deleted.
 */
describe('ImportQueueWorker — forced refusal serializes its terminal disposition (#2481, DB-backed)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let logger: FastifyBaseLogger;
  let bookService: BookService;
  let eventHistory: EventHistoryService;
  let deletionService: BookDeletionService;
  let emitSpy: Mock;
  let reconcileBook: Mock<(bookId: number) => Promise<void>>;
  let worker: ImportQueueWorker;
  /** Case 10 runs against every book a case seeded, so no case can leak a key unobserved. */
  let seededBookIds: number[];
  let openGates: (() => void)[];

  beforeEach(async () => {
    hoisted.events.length = 0;
    seededBookIds = [];
    openGates = [];
    dir = mkdtempSync(join(tmpdir(), 'iqw-refused-race-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    logger = inject<FastifyBaseLogger>(log);

    bookService = new BookService(db, logger);
    eventHistory = new EventHistoryService(db, logger, inject<BlacklistService>({}), bookService);
    deletionService = new BookDeletionService(
      db,
      bookService,
      inject<DownloadService>({ getActiveByBookId: vi.fn().mockResolvedValue([]) }),
      inject<DownloadOrchestrator>({ cancel: vi.fn() }),
      inject<SettingsService>({ get: vi.fn().mockResolvedValue({ path: '/audiobooks' }) }),
      logger,
      eventHistory,
    );

    clearImportAdapters();
    emitSpy = vi.fn();
    reconcileBook = vi.fn().mockResolvedValue(undefined);
    worker = new ImportQueueWorker(
      db, logger, inject<EventBroadcasterService>({ emit: emitSpy }), undefined, eventHistory, { reconcileBook },
    );
  });

  afterEach(async () => {
    // Release anything still parked first: a live section would hang stop() rather than fail.
    for (const release of openGates) release();
    await worker.stop();
    await settle();

    // Case 10 — the key is evicted, not leaked. Never used as acquisition evidence.
    for (const bookId of seededBookIds) {
      expect(hasPendingBookAdmission(bookId)).toBe(false);
    }

    clearImportAdapters();
    vi.restoreAllMocks();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may retain Windows handles; cleanup is best-effort.
    }
  });

  function gate() {
    const d = deferred();
    openGates.push(() => { d.resolve(); });
    return d;
  }

  async function seedForcedJob(
    title = 'Forced Book',
    status: 'importing' | 'imported' = 'importing',
  ): Promise<{ bookId: number; jobId: number }> {
    const book = await bookService.create({ title, authors: [{ name: 'Author' }], narrators: ['Narrator'], status });
    const [job] = await db.insert(importJobs).values({
      bookId: book.id,
      type: 'manual',
      status: 'pending',
      phase: 'queued',
      metadata: JSON.stringify({ path: `/dl/${title}`, title, forceImport: true }),
    }).returning();
    seededBookIds.push(book.id);
    return { bookId: book.id, jobId: job!.id };
  }

  const refusalError = (overrides: Partial<{ existingBookId: number; title: string; reason: string }> = {}) =>
    new OwnedRecordingError({
      existingBookId: 99, title: 'Owned', reason: 'recording-review', ...overrides,
    } as ConstructorParameters<typeof OwnedRecordingError>[0]);

  /** The fake the existing refusal suite uses: it throws without ever taking admission. */
  function registerRefusingAdapter(error: unknown): void {
    registerImportAdapter({ type: 'manual', async process() { throw error; } } as ImportAdapter);
  }

  /**
   * The production shape: `ManualImportAdapter.process` holds admission across its work and
   * releases it when the refusal propagates. Without this the release/reacquire gap is invisible.
   */
  function registerParkedRefusingAdapter(
    error: unknown,
    entered: Deferred,
    release: Deferred,
  ): void {
    registerImportAdapter({
      type: 'manual',
      async process(job) {
        return withBookAdmissionLock(job.bookId!, async () => {
          entered.resolve();
          await release.promise;
          throw error;
        });
      },
    } as ImportAdapter);
  }

  const grants = (bookId: number) =>
    hoisted.events.filter((e) => e === `lock.held:${bookId}` || e === `lock.release:${bookId}`);
  const acquisitions = (bookId: number) => hoisted.events.filter((e) => e === `lock.acquire:${bookId}`);

  async function jobRow(jobId: number) {
    const [row] = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
    return row!;
  }

  async function bookRow(bookId: number) {
    const [row] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    return row;
  }

  /** Two of AC6's three arms persist `book_id` NULL by contract, so never key this on the id. */
  async function refusalEvents(bookTitle: string) {
    const rows = await db.select().from(bookEvents);
    return rows.filter((r) => r.eventType === 'import_failed' && r.bookTitle === bookTitle);
  }

  function failedEmissions() {
    return emitSpy.mock.calls.filter((c) => c[0] === 'import_failed');
  }

  const deps = (overrides: Partial<RefusedDispositionDeps> = {}): RefusedDispositionDeps => ({
    db,
    broadcaster: inject<EventBroadcasterService>({ emit: emitSpy }),
    eventHistory,
    log: logger,
    ...overrides,
  });

  /**
   * One-shot wrapper over the shadowed `db.transaction`. Armed by an explicit flag rather than call
   * position, so it cannot fire on an unrelated transaction and make a case pass for the wrong
   * reason. The refusal path opens exactly one transaction after the throw.
   */
  function installOneShotTransactionSeam(before: () => Promise<void>) {
    const original = db.transaction.bind(db) as Db['transaction'];
    let armed = false;
    let interceptions = 0;
    db.transaction = ((...args: Parameters<Db['transaction']>) => {
      if (!armed) return original(...args);
      armed = false;
      interceptions++;
      return (async () => {
        await before();
        db.transaction = original;
        return original(...args);
      })();
    }) as Db['transaction'];
    return {
      arm: () => { armed = true; },
      interceptions: () => interceptions,
      restore: () => { db.transaction = original; },
    };
  }

  describe('race conditions & stale data', () => {
    // Case 1 — the mid-flight assertion is the one that reds when the wrapper is removed.
    it('case 1: blocks the whole disposition while a queued identity edit holds admission', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      await worker.start();
      await entered.promise;

      const contenderEntered = deferred();
      const contenderGate = gate();
      let edited: Awaited<ReturnType<BookService['update']>> = null;
      const contender = withBookAdmissionLock(bookId, async () => {
        contenderEntered.resolve();
        await contenderGate.promise;
        edited = await bookService.update(bookId, { title: 'Operator Edit' }, { userAsserted: true });
      });

      adapterGate.resolve();
      await contenderEntered.promise;
      await settle();

      // Mid-flight: the contender holds admission and has opened no transaction, so nothing but
      // the admission tier can be holding the finalizer back.
      expect((await jobRow(jobId)).status).not.toBe('failed');
      expect(await bookRow(bookId)).toBeDefined();

      contenderGate.resolve();
      await contender;
      await worker.stop();

      expect(edited).not.toBeNull();
      expect(edited!.title).toBe('Operator Edit');
      expect(await bookRow(bookId)).toBeUndefined();
      const job = await jobRow(jobId);
      expect(job.status).toBe('failed');
      expect(job.phase).toBe('failed');
      expect(job.bookId).toBeNull();

      const events = await refusalEvents('Forced Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBeNull();

      expect(await db.select().from(bookAuthors).where(eq(bookAuthors.bookId, bookId))).toHaveLength(0);
      expect(await db.select().from(bookNarrators).where(eq(bookNarrators.bookId, bookId))).toHaveLength(0);

      const emissions = failedEmissions();
      expect(emissions).toHaveLength(1);
      // Case 17 — the removed arm stays on the shared SSE contract.
      expect(importFailedPayload.safeParse(emissions[0]![1]).success).toBe(true);
      expect(emissions[0]![1]).toMatchObject({ job_id: jobId, book_id: bookId, book_title: 'Forced Book' });
    });

    // Case 2 — the arm HEAD gets wrong in both directions: the delete misses, yet it still reports removal.
    it('case 2: a queued edit that moves the row off importing survives, and the event links it', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      await worker.start();
      await entered.promise;

      const contenderEntered = deferred();
      const contenderGate = gate();
      const contender = withBookAdmissionLock(bookId, async () => {
        contenderEntered.resolve();
        await contenderGate.promise;
        await bookService.update(bookId, { status: 'imported' }, { userAsserted: true });
      });

      adapterGate.resolve();
      await contenderEntered.promise;
      await settle();

      expect((await jobRow(jobId)).status).not.toBe('failed');
      expect((await bookRow(bookId))!.status).toBe('importing');

      contenderGate.resolve();
      await contender;
      await worker.stop();

      const survivor = await bookRow(bookId);
      expect(survivor).toBeDefined();
      expect(survivor!.status).toBe('imported');

      const job = await jobRow(jobId);
      expect(job.status).toBe('failed');
      expect(JSON.parse(job.lastError!).refusal).toMatchObject({ kind: 'forced-import-refused', existingBookId: 99 });
      expect(job.bookId).toBe(bookId);

      const events = await refusalEvents('Forced Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBe(bookId);

      const emissions = failedEmissions();
      expect(emissions).toHaveLength(1);
      // Case 17 — the survived arm cannot introduce an off-contract SSE.
      expect(importFailedPayload.safeParse(emissions[0]![1]).success).toBe(true);
      expect(emissions[0]![1]).toMatchObject({ book_id: bookId, book_title: 'Forced Book' });
    });

    // Case 3 — the operator-facing deletion, which acquires admission itself.
    it('case 3: a full deletion that wins admission leaves the finalizer nothing to delete', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      await worker.start();
      await entered.promise;

      const deletion = deletionService.deleteBook(bookId, { deleteFiles: false });
      adapterGate.resolve();
      const outcome = await deletion;
      await worker.stop();

      expect(outcome).toMatchObject({ outcome: 'deleted' });
      const deletedEvents = (await db.select().from(bookEvents)).filter((r) => r.eventType === 'deleted');
      expect(deletedEvents).toHaveLength(1);

      expect(await bookRow(bookId)).toBeUndefined();
      const job = await jobRow(jobId);
      expect(job.status).toBe('failed');
      expect(job.phase).toBe('failed');

      // Linking a vanished id would be rejected by the real FK and lose the row entirely.
      const events = await refusalEvents('Forced Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBeNull();

      expect(failedEmissions()[0]![1]).toMatchObject({ book_id: bookId });

      // Three actors, so six strictly alternating grants; the finalizer is granted last.
      const sequence = grants(bookId);
      expect(sequence).toEqual([
        `lock.held:${bookId}`, `lock.release:${bookId}`,
        `lock.held:${bookId}`, `lock.release:${bookId}`,
        `lock.held:${bookId}`, `lock.release:${bookId}`,
      ]);
      expect(sequence.length).toBe(6);
      const releases = hoisted.events.filter((e) => e === `lock.release:${bookId}`);
      expect(releases).toHaveLength(3);
      expect(hoisted.events.indexOf(`lock.release:${bookId}`)).toBeLessThan(
        hoisted.events.lastIndexOf(`lock.held:${bookId}`),
      );
    });

    // Case 4 — the job→book relationship is re-read inside the section, not trusted from args.
    it('case 4: refuses the delete when the job no longer points at the book', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      await worker.start();
      await entered.promise;

      const contenderEntered = deferred();
      const contenderGate = gate();
      const contender = withBookAdmissionLock(bookId, async () => {
        contenderEntered.resolve();
        await contenderGate.promise;
        await db.update(importJobs).set({ bookId: null }).where(eq(importJobs.id, jobId));
      });

      adapterGate.resolve();
      await contenderEntered.promise;
      contenderGate.resolve();
      await contender;
      await worker.stop();

      const survivor = await bookRow(bookId);
      expect(survivor).toBeDefined();
      expect(survivor!.status).toBe('importing');
      expect(survivor!.title).toBe('Forced Book');

      const job = await jobRow(jobId);
      expect(job.status).toBe('failed');
      expect(job.phase).toBe('failed');
    });

    // Case 5 — the companion to case 1: which code path made the acquisition.
    it('case 5: a non-admission-taking adapter still produces exactly one acquisition — the finalizer’s', async () => {
      const { bookId, jobId } = await seedForcedJob();
      registerRefusingAdapter(refusalError());

      await worker.start();
      await new Promise((r) => setTimeout(r, 150));
      await worker.stop();

      expect(acquisitions(bookId)).toHaveLength(1);
      expect(grants(bookId)).toEqual([`lock.held:${bookId}`, `lock.release:${bookId}`]);
      expect((await jobRow(jobId)).status).toBe('failed');
      expect(await bookRow(bookId)).toBeUndefined();
    });
  });

  describe('boundary values, null and missing paths', () => {
    // Case 6 — AC3: no acquisition at all, and the trace is the only thing that can prove it.
    it('case 6: a null bookId finalizes with zero acquisitions and an unlinked event', async () => {
      const [job] = await db.insert(importJobs).values({
        type: 'manual',
        status: 'pending',
        phase: 'queued',
        metadata: JSON.stringify({ path: '/dl/Orphan Book', title: 'Orphan Book', forceImport: true }),
      }).returning();
      registerRefusingAdapter(refusalError());

      await worker.start();
      await new Promise((r) => setTimeout(r, 150));
      await worker.stop();

      expect(hoisted.events.filter((e) => e.startsWith('lock.acquire:'))).toHaveLength(0);
      const row = await jobRow(job!.id);
      expect(row.status).toBe('failed');
      expect(row.phase).toBe('failed');
      expect(JSON.parse(row.lastError!).type).toBe('OwnedRecordingError');

      const events = await refusalEvents('Orphan Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBeNull();
      expect(failedEmissions()[0]![1]).toMatchObject({ book_id: null, book_title: 'Orphan Book' });
    });

    // Case 7 — the SQL predicate is unreachable unless something mutates between the in-lock
    // pre-read and the guarded delete, so the window is constructed with a test-only seam.
    it('case 7: the guarded delete still misses when the status flips after the pre-read', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      const seam = installOneShotTransactionSeam(async () => {
        // A bare statement, not a transaction: no nesting guard is involved and none is open.
        await db.update(books).set({ status: 'imported' }).where(eq(books.id, bookId));
      });

      await worker.start();
      await entered.promise;
      seam.arm();
      adapterGate.resolve();
      await worker.stop();
      seam.restore();

      expect(seam.interceptions()).toBe(1);

      const survivor = await bookRow(bookId);
      expect(survivor).toBeDefined();
      expect(survivor!.status).toBe('imported');

      const job = await jobRow(jobId);
      expect(job.status).toBe('failed');
      expect(JSON.parse(job.lastError!).refusal).toMatchObject({ kind: 'forced-import-refused' });
      // placeholderRemoved === false, observable durably in both directions.
      expect(job.bookId).toBe(bookId);
      const events = await refusalEvents('Forced Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBe(bookId);
    });

    // Case 8 — omitted phase history is left untouched rather than overwritten with undefined.
    it('case 8: leaves phase_history untouched when the caller supplies none', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const existing = JSON.stringify([{ phase: 'copying', startedAt: 1 }]);
      await db.update(importJobs).set({ phaseHistory: existing }).where(eq(importJobs.id, jobId));

      await finalizeForcedImportRefusal(deps(), {
        jobId, bookId, currentPhase: 'copying', bookTitle: 'Forced Book', error: refusalError(),
      });

      const job = await jobRow(jobId);
      expect(job.phaseHistory).toBe(existing);
      expect(job.status).toBe('failed');
    });

    // Case 9 — the ownerless sentinel through the admission path.
    it('case 9: the -1 sentinel still reports a null owner under the lock', async () => {
      const { bookId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(
        refusalError({ existingBookId: -1, title: 'New Recording', reason: 'recording-review-no-disambiguator' }),
        entered,
        adapterGate,
      );

      await worker.start();
      await entered.promise;
      adapterGate.resolve();
      await worker.stop();

      const payload = failedEmissions()[0]![1];
      expect(payload.refusal_reason).toMatchObject({
        kind: 'forced-import-refused', recordingReason: 'recording-review-no-disambiguator', existingBookId: null,
      });
      expect(payload.error_message).not.toContain('#-1');
      expect(payload.error_message).toContain('no identifiable owner');
      expect(acquisitions(bookId)).toHaveLength(2);
    });
  });

  describe('error isolation', () => {
    // Case 11 — AC9's caught-inside-the-transaction rule. A propagating insert failure would
    // abort the disposition and strand the job non-terminal.
    it('case 11: an event insert that rejects inside the transaction still commits the disposition', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const logRecorded = vi.fn();
      const rejecting = inject<EventHistoryService>({
        create: vi.fn().mockRejectedValue(new Error('event insert exploded')),
        logRecorded,
      });

      await finalizeForcedImportRefusal(deps({ eventHistory: rejecting }), {
        jobId, bookId, currentPhase: 'copying', bookTitle: 'Forced Book', error: refusalError(), phaseHistory: [],
      });

      const job = await jobRow(jobId);
      expect(job.status).toBe('failed');
      expect(JSON.parse(job.lastError!).refusal).toMatchObject({ kind: 'forced-import-refused' });
      expect(await bookRow(bookId)).toBeUndefined();
      expect(await db.select().from(bookEvents)).toHaveLength(0);
      expect(logRecorded).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
      expect(failedEmissions()).toHaveLength(1);
    });

    // Case 12 — the broadcaster seam is optional and changes nothing durable.
    it('case 12: a null broadcaster no-ops and leaves the same durable state', async () => {
      const { bookId, jobId } = await seedForcedJob();

      await finalizeForcedImportRefusal(deps({ broadcaster: null }), {
        jobId, bookId, currentPhase: 'copying', bookTitle: 'Forced Book', error: refusalError(), phaseHistory: [],
      });

      expect(emitSpy).not.toHaveBeenCalled();
      expect((await jobRow(jobId)).status).toBe('failed');
      expect(await bookRow(bookId)).toBeUndefined();
      const events = await refusalEvents('Forced Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBeNull();
    });

    // Case 13 — a rejecting section must not poison the key for the next mutator.
    it('case 13: releases admission when the terminal transaction itself throws', async () => {
      const { bookId, jobId } = await seedForcedJob();
      const original = db.transaction.bind(db) as Db['transaction'];
      db.transaction = (() => Promise.reject(new Error('transaction exploded'))) as Db['transaction'];

      await expect(finalizeForcedImportRefusal(deps(), {
        jobId, bookId, currentPhase: 'copying', bookTitle: 'Forced Book', error: refusalError(),
      })).rejects.toThrow('transaction exploded');

      db.transaction = original;
      await settle();
      expect(hasPendingBookAdmission(bookId)).toBe(false);

      const after = await withBookAdmissionLock(bookId, () =>
        bookService.update(bookId, { title: 'After The Failure' }, { userAsserted: true }));
      expect(after!.title).toBe('After The Failure');
    });
  });

  describe('transient vs persisted state', () => {
    // Case 14 — the SSE title stays the job-payload title in every arm.
    it('case 14: reports the job-payload title even when the surviving row was renamed', async () => {
      const { bookId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      await worker.start();
      await entered.promise;

      const contenderEntered = deferred();
      const contenderGate = gate();
      const contender = withBookAdmissionLock(bookId, async () => {
        contenderEntered.resolve();
        await contenderGate.promise;
        await bookService.update(bookId, { title: 'Renamed By Operator', status: 'imported' }, { userAsserted: true });
      });

      adapterGate.resolve();
      await contenderEntered.promise;
      contenderGate.resolve();
      await contender;
      await worker.stop();

      expect((await bookRow(bookId))!.title).toBe('Renamed By Operator');
      expect(failedEmissions()[0]![1].book_title).toBe('Forced Book');
      expect(await refusalEvents('Forced Book')).toHaveLength(1);
    });
  });

  describe('filter and feature interactions', () => {
    // Case 15 — the generic path neither acquires nor leaks.
    it('case 15: a non-forced OwnedRecordingError keeps its placeholder and acquires nothing', async () => {
      const book = await bookService.create({ title: 'Plain Book', authors: [{ name: 'Author' }], status: 'importing' });
      seededBookIds.push(book.id);
      const [job] = await db.insert(importJobs).values({
        bookId: book.id,
        type: 'manual',
        status: 'pending',
        phase: 'queued',
        metadata: JSON.stringify({ path: '/dl/Plain Book', title: 'Plain Book' }),
      }).returning();
      registerRefusingAdapter(refusalError());

      await worker.start();
      await new Promise((r) => setTimeout(r, 150));
      await worker.stop();

      expect(hoisted.events.filter((e) => e.startsWith('lock.acquire:'))).toHaveLength(0);
      const row = await jobRow(job!.id);
      expect(row.status).toBe('failed');
      expect(row.bookId).toBe(book.id);
      expect((await bookRow(book.id))!.status).toBe('failed');
      expect(await db.select().from(bookEvents)).toHaveLength(0);
    });

    it('case 15b: a non-Owned failure keeps its placeholder and acquires nothing', async () => {
      const { bookId, jobId } = await seedForcedJob();
      registerRefusingAdapter(new Error('disk full'));

      await worker.start();
      await new Promise((r) => setTimeout(r, 150));
      await worker.stop();

      expect(hoisted.events.filter((e) => e.startsWith('lock.acquire:'))).toHaveLength(0);
      const row = await jobRow(jobId);
      expect(row.status).toBe('failed');
      expect(row.bookId).toBe(bookId);
      expect((await bookRow(bookId))!.status).toBe('failed');
      expect(failedEmissions()[0]![1].error_message).toContain('disk full');
    });

    // Case 16 — refusal never enqueues reconciliation; the positive control proves the spy is live.
    it('case 16: a refused import never enqueues companion reconciliation', async () => {
      const { bookId } = await seedForcedJob();
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      await worker.start();
      await entered.promise;
      adapterGate.resolve();
      await worker.stop();

      expect(reconcileBook).not.toHaveBeenCalled();
      expect(await bookRow(bookId)).toBeUndefined();
    });

    it('case 16b: positive control — a succeeding import on this worker fires exactly one reconcile', async () => {
      const { bookId, jobId } = await seedForcedJob();
      registerImportAdapter({ type: 'manual', async process() { /* succeeds */ } } as ImportAdapter);

      await worker.start();
      await new Promise((r) => setTimeout(r, 150));
      await worker.stop();

      expect((await jobRow(jobId)).status).toBe('completed');
      expect(reconcileBook).toHaveBeenCalledTimes(1);
      expect(reconcileBook).toHaveBeenCalledWith(bookId);
    });
  });

  describe('durable-event serialization (AC9)', () => {
    // Case 18 — the deterministic counterfactual: the insert happens while admission is held,
    // on the caller-owned transaction. Reds the moment the write moves back outside the section.
    it('case 18: inserts the refusal event on the terminal transaction while admission is held', async () => {
      const { bookId } = await seedForcedJob();
      registerRefusingAdapter(refusalError());

      const original = eventHistory.create.bind(eventHistory);
      let snapshot: string[] = [];
      let sawTransaction = false;
      vi.spyOn(eventHistory, 'create').mockImplementation(async (input, tx) => {
        snapshot = [...hoisted.events];
        sawTransaction = tx !== undefined;
        return original(input, tx);
      });

      await worker.start();
      await new Promise((r) => setTimeout(r, 150));
      await worker.stop();

      expect(sawTransaction).toBe(true);
      const forThisBook = snapshot.filter((e) => e.endsWith(`:${bookId}`));
      expect(forThisBook[forThisBook.length - 1]).toBe(`lock.held:${bookId}`);
      expect(forThisBook).not.toContain(`lock.release:${bookId}`);
      expect(await refusalEvents('Forced Book')).toHaveLength(1);
    });

    /**
     * Case 19 — end-to-end durability. Per spec-review F9 the surviving arm is seeded rather than
     * produced by a contender: `BookService.update` opens its own transaction, which would reach
     * the seam first, while the CONTENDER (not the finalizer) still holds admission. Seeding
     * `imported` makes the finalizer's transaction genuinely the seam's first invocation, and the
     * trace precondition below asserts that rather than assuming it.
     */
    it('case 19: a deletion queued behind the finalizer cannot erase the refusal event', async () => {
      const { bookId, jobId } = await seedForcedJob('Forced Book', 'imported');
      const entered = deferred();
      const adapterGate = gate();
      registerParkedRefusingAdapter(refusalError(), entered, adapterGate);

      let precondition: string[] = [];
      let deletion: Promise<unknown> | null = null;
      const seam = installOneShotTransactionSeam(async () => {
        precondition = hoisted.events.filter((e) => e.endsWith(`:${bookId}`));
        // Queues on admission behind the section that is open right now.
        deletion = deletionService.deleteBook(bookId, { deleteFiles: false });
      });

      await worker.start();
      await entered.promise;
      seam.arm();
      adapterGate.resolve();
      await worker.stop();
      seam.restore();

      expect(seam.interceptions()).toBe(1);
      // The finalizer — not the contender — is what the seam observed.
      expect(precondition[precondition.length - 1]).toBe(`lock.held:${bookId}`);

      expect(deletion).not.toBeNull();
      expect(await deletion).toMatchObject({ outcome: 'deleted' });

      // The row surviving with a nulled link is the contract; its absence is the defect.
      const events = await refusalEvents('Forced Book');
      expect(events).toHaveLength(1);
      expect(events[0]!.bookId).toBeNull();
      expect((await jobRow(jobId)).status).toBe('failed');

      const sequence = grants(bookId);
      expect(sequence.lastIndexOf(`lock.held:${bookId}`)).toBeGreaterThan(sequence.indexOf(`lock.release:${bookId}`));
      expect(await bookRow(bookId)).toBeUndefined();
    });
  });
});
