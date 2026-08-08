import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, asc } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importJobs, importSubmissions, importSubmissionItems } from '@db/schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { BookService } from './book.service.js';
import { BookImportService } from './book-import.service.js';
import { ImportSubmissionRunner } from './import-submission-runner.js';
import { ImportStagingService } from './import-staging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { NotifierService } from './notifier.service.js';
import { serializeSubmissionForDigest, type StagedImportItem } from '@core/import-staging/schemas.js';
import { manualImportJobPayloadSchema } from './import-adapters/types.js';

interface DrainSeam { drainOne(): Promise<boolean> }

/** A notifier stub — an optional `notify` spy lets a test assert completion dispatch. */
function stubNotifier(notify: unknown = () => Promise.resolve()): NotifierService {
  return { notify } as unknown as NotifierService;
}

function acceptedItem(path: string, title: string): StagedImportItem {
  return { path, title, forceImport: true, metadata: { title, authors: [{ name: 'Author' }] } };
}

describe('ImportSubmissionRunner (DB-backed, #1893)', () => {
  let dir: string;
  let dbFile: string;
  let db: Db;
  let runner: ImportSubmissionRunner;
  let nudge: ReturnType<typeof vi.fn>;
  let eventCreate: ReturnType<typeof vi.fn>;
  let notifyStub: ReturnType<typeof vi.fn>;
  const log = createMockLogger();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-'));
    dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    nudge = vi.fn();
    eventCreate = vi.fn().mockResolvedValue(undefined);
    notifyStub = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: eventCreate } as unknown as EventHistoryService;
    runner = new ImportSubmissionRunner({
      db,
      log: inject(log),
      bookService: new BookService(db, inject(log)),
      bookImportService: new BookImportService(db, inject(log)),
      eventHistory,
      notifier: stubNotifier(notifyStub),
      nudgeImportWorker: nudge as unknown as () => void,
    });
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function seedProcessing(items: (StagedImportItem | null)[], header?: { source?: 'library' | 'manual'; mode?: 'copy' | 'move' }): Promise<number> {
    const [sub] = await db.insert(importSubmissions).values({
      clientSubmissionId: `c-${items.length}-${Math.round(performance.now())}-${Math.random()}`,
      payloadDigest: 'a'.repeat(64), source: header?.source ?? 'library', mode: header?.mode ?? null,
      expectedCount: items.length, status: 'processing', receivedCount: items.length,
    }).returning();
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      await db.insert(importSubmissionItems).values({
        submissionId: sub!.id, ordinal: i, itemPayload: it, path: it?.path ?? `/p${i}`, title: it?.title ?? `T${i}`, disposition: 'pending',
      });
    }
    return sub!.id;
  }

  async function drainRunner(r: ImportSubmissionRunner): Promise<void> {
    // Disposition-policy tests exercise drainOne directly (not lifecycle); flip
    // `running` so the F72 pre-claim barrier does not abort.
    (r as unknown as { running: boolean }).running = true;
    const seam = r as unknown as DrainSeam;
    let guard = 0;
    while (await seam.drainOne()) {
      if (++guard > 1000) throw new Error('drain did not converge');
    }
    (r as unknown as { running: boolean }).running = false;
  }

  async function drainAll(): Promise<void> {
    await drainRunner(runner);
  }

  function makeRunner(bookService: BookService, bookImportService?: BookImportService): ImportSubmissionRunner {
    return new ImportSubmissionRunner({
      db,
      log: inject(log),
      bookService,
      bookImportService: bookImportService ?? new BookImportService(db, inject(log)),
      eventHistory: { create: eventCreate } as unknown as EventHistoryService,
      notifier: stubNotifier(notifyStub),
      nudgeImportWorker: nudge as unknown as () => void,
    });
  }

  /** A runner over its OWN libSQL connection to the same file (real multi-process contention). */
  function makeRunnerWithDb(rdb: Db): ImportSubmissionRunner {
    return new ImportSubmissionRunner({
      db: rdb,
      log: inject(log),
      bookService: new BookService(rdb, inject(log)),
      bookImportService: new BookImportService(rdb, inject(log)),
      eventHistory: { create: eventCreate } as unknown as EventHistoryService,
      notifier: stubNotifier(notifyStub),
      nudgeImportWorker: nudge as unknown as () => void,
    });
  }

  async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor timed out');
  }

  /**
   * The fake-timer counterpart to {@link waitFor} — which cannot be used under
   * `vi.useFakeTimers()`, since its own `setTimeout(…, 10)` never fires. Each
   * `advanceTimersByTimeAsync` both runs due timers AND flushes the microtask queue, so
   * it is what lets the genuinely async (DB-backed) drain make progress while the clock
   * is mocked.
   *
   * A single FIXED advance is what made F19 flake under full-suite load (#2176): the
   * drain needs however many event-loop turns the saturated worker pool gives it, so a
   * one-shot 200ms budget is a bet on scheduler timing rather than a synchronisation
   * point. Looping on the observable state removes the timing dependency without
   * weakening the assertion — the caller still asserts the settled value itself.
   */
  async function advanceUntil(cond: () => Promise<boolean> | boolean, stepMs = 100, maxSteps = 200): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      if (await cond()) return;
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    throw new Error('advanceUntil timed out');
  }

  const isComplete = (subId: number) => async (): Promise<boolean> => {
    const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
    return h!.status === 'complete';
  };

  it('processes accepted items: creates placeholder + job, sets disposition/bookId, completes with aggregates', async () => {
    const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);

    await drainAll();

    expect(await db.select().from(books)).toHaveLength(2);
    const jobs = await db.select().from(importJobs);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === 'pending' && j.type === 'manual')).toBe(true);

    const items = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
    expect(items.every((i) => i.disposition === 'accepted' && i.bookId != null)).toBe(true);

    const [header] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
    expect(header!.status).toBe('complete');
    expect(header!.acceptedCount).toBe(2);
    expect(header!.completedAt).not.toBeNull();
    expect(nudge).toHaveBeenCalled();
    expect(eventCreate).toHaveBeenCalledTimes(2);
    expect(eventCreate.mock.calls[0]![0]).toMatchObject({ eventType: 'book_added', source: 'manual' });
  });

  it('marks a payload-missing item failed and still completes the header', async () => {
    const subId = await seedProcessing([null]);

    await drainAll();

    const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
    expect(item!.disposition).toBe('failed');
    const [header] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
    expect(header!.status).toBe('complete');
    expect(header!.failedCount).toBe(1);
    // No book/job for a failed item.
    expect(await db.select().from(books)).toHaveLength(0);
    expect(await db.select().from(importJobs)).toHaveLength(0);
  });

  it('boot-resume: a re-drive never re-processes already-terminal items', async () => {
    const subId = await seedProcessing([acceptedItem('/a', 'A')]);
    await drainAll();
    const booksAfterFirst = await db.select().from(books);
    const jobsAfterFirst = await db.select().from(importJobs);

    // Simulate a restart: build a fresh runner over the same DB and re-drive.
    runner = new ImportSubmissionRunner({
      db, log: inject(log),
      bookService: new BookService(db, inject(log)),
      bookImportService: new BookImportService(db, inject(log)),
      eventHistory: { create: eventCreate } as unknown as EventHistoryService,
      notifier: stubNotifier(notifyStub),
      nudgeImportWorker: nudge as unknown as () => void,
    });
    await drainAll();

    expect(await db.select().from(books)).toHaveLength(booksAfterFirst.length);
    expect(await db.select().from(importJobs)).toHaveLength(jobsAfterFirst.length);
    const [header] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
    expect(header!.status).toBe('complete');
  });

  it('resumes a partially-processed submission from its first pending item', async () => {
    const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);
    // Pretend ordinal 0 was already accepted before a crash.
    const [firstBook] = await db.insert(books).values({ publicId: 'pre-book', title: 'A', status: 'importing' }).returning();
    await db.update(importSubmissionItems)
      .set({ disposition: 'accepted', bookId: firstBook!.id })
      .where(eq(importSubmissionItems.ordinal, 0));

    await drainAll();

    const items = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
    expect(items.every((i) => i.disposition === 'accepted')).toBe(true);
    // Only ordinal 1 got a freshly created book (ordinal 0 kept its pre-seeded one).
    expect(await db.select().from(books)).toHaveLength(2);
    const [header] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
    expect(header!.status).toBe('complete');
    expect(header!.acceptedCount).toBe(2);
  });

  // ── F9/F2/F3/F5: per-item disposition policy (each policy-table row) ──────
  describe('disposition policy (F9, F2, F3, F5)', () => {
    async function seedBook(overrides: Record<string, unknown>): Promise<number> {
      const [b] = await db.insert(books).values({ publicId: `pub-${Math.round(performance.now())}-${Math.random()}`, title: 'Incumbent', status: 'imported', ...overrides }).returning();
      return b!.id;
    }

    it('same-recording → skipped(already-in-library) carrying incumbent id+title; no book/job (F9)', async () => {
      const incId = await seedBook({ title: 'Incumbent' });
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'same-recording', book: { id: incId, title: 'Incumbent' } as never, hasIncumbent: true });
      const subId = await seedProcessing([{ path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } }]);

      await drainRunner(makeRunner(bs));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-in-library');
      expect(item!.existingBookId).toBe(incId);
      expect(item!.existingTitle).toBe('Incumbent');
      expect(await db.select().from(books)).toHaveLength(1); // only the incumbent
      expect(await db.select().from(importJobs)).toHaveLength(0);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.skippedCount).toBe(1);
    });

    it('review → held(recording-review-required) with incumbent id; no book/job (F9)', async () => {
      const incId = await seedBook({ title: 'Review Incumbent' });
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'review', book: { id: incId, title: 'Review Incumbent' } as never, hasIncumbent: true });
      const subId = await seedProcessing([{ path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } }]);

      await drainRunner(makeRunner(bs));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('held');
      expect(item!.reason).toBe('recording-review-required');
      expect(item!.existingBookId).toBe(incId);
      expect(await db.select().from(books)).toHaveLength(1);
      expect(await db.select().from(importJobs)).toHaveLength(0);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.heldCount).toBe(1);
    });

    it('proceed + active-job conflict → skipped(already-importing); placeholder rolled back (F9)', async () => {
      const bs = new BookService(db, inject(log));
      const bis = new BookImportService(db, inject(log));
      vi.spyOn(bis, 'enqueue').mockResolvedValue({ error: 'active-job-exists' } as never);
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      await drainRunner(makeRunner(bs, bis));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-importing');
      // The placeholder created inside the tx rolled back with the conflict.
      expect(await db.select().from(books)).toHaveLength(0);
      expect(await db.select().from(importJobs)).toHaveLength(0);
    });

    it('same-ASIN create-time race → skipped(already-in-library) with incumbent (F2, real DB unique index)', async () => {
      const incId = await seedBook({ title: 'Owner', asin: 'B0RACE1' });
      const subId = await seedProcessing([{ path: '/a', title: 'A', forceImport: true, metadata: { title: 'A', authors: [{ name: 'X' }], asin: 'B0RACE1' } }]);

      await drainRunner(makeRunner(new BookService(db, inject(log))));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-in-library');
      expect(item!.existingBookId).toBe(incId);
      expect(item!.existingTitle).toBe('Owner');
      // Only the incumbent exists — the placeholder hit the unique index and rolled back.
      expect(await db.select().from(books)).toHaveLength(1);
      expect(await db.select().from(importJobs)).toHaveLength(0);
    });

    it('unexpected preparation error → failed and the drain continues to the next ordinal (F3)', async () => {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'resolveCreateInput').mockRejectedValueOnce(new Error('provider boom'));
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);

      await drainRunner(makeRunner(bs));

      const rows = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
      expect(rows[0]!.disposition).toBe('failed');
      expect(rows[1]!.disposition).toBe('accepted');
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.failedCount).toBe(1);
      expect(h!.acceptedCount).toBe(1);
    });

    it('malformed persisted item payload → failed at the read boundary (F5)', async () => {
      const [sub] = await db.insert(importSubmissions).values({
        clientSubmissionId: `c-bad-${Math.round(performance.now())}`, payloadDigest: 'a'.repeat(64), source: 'library', expectedCount: 1, status: 'processing', receivedCount: 1,
      }).returning();
      // A structurally-invalid persisted blob (SQLite does not enforce the JSON $type).
      await db.insert(importSubmissionItems).values({ submissionId: sub!.id, ordinal: 0, itemPayload: { bogus: true } as never, path: '/a', title: 'A', disposition: 'pending' });

      await drainRunner(makeRunner(new BookService(db, inject(log))));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, sub!.id));
      expect(item!.disposition).toBe('failed');
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, sub!.id));
      expect(h!.status).toBe('complete');
      expect(h!.failedCount).toBe(1);
      expect(await db.select().from(books)).toHaveLength(0);
    });
  });

  // ── F35/F39/F40: crash atomicity, post-commit side effects, provider ordering ──
  describe('accepted-item crash atomicity, side effects & provider ordering (F35/F39/F40)', () => {
    // Simulate PROCESS DEATH after a mid-tx crash: the accepted tx rolls back AND the
    // terminal-disposition write does not land (writeTerminal no-op'd once), so the item
    // is left 'pending' for boot recovery — a live process would instead mark it failed.
    async function crashOnce(runner: ImportSubmissionRunner): Promise<void> {
      vi.spyOn(runner as unknown as { writeTerminal: (...a: unknown[]) => Promise<void> }, 'writeTerminal').mockResolvedValueOnce(undefined);
      (runner as unknown as { running: boolean }).running = true;
      await (runner as unknown as DrainSeam).drainOne();
      (runner as unknown as { running: boolean }).running = false;
    }

    it('crash AFTER enqueue rolls back book+job (no orphan); a re-driven runner completes the still-pending item once (F35)', async () => {
      const bs = new BookService(db, inject(log));
      const bis = new BookImportService(db, inject(log));
      const originalEnqueue = bis.enqueue.bind(bis);
      vi.spyOn(bis, 'enqueue').mockImplementation(async (input, tx) => {
        await originalEnqueue(input, tx); // real in-tx job insert
        throw new Error('crash after enqueue'); // then die → the whole tx rolls back
      });
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      await crashOnce(makeRunner(bs, bis));

      // No orphan: the book insert AND the job enqueue rolled back with the crashing tx.
      expect(await db.select().from(books)).toHaveLength(0);
      expect(await db.select().from(importJobs)).toHaveLength(0);
      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('pending'); // left pending for recovery

      // Boot recovery: a fresh runner re-drives and completes the item ONCE (no duplicate).
      await drainRunner(makeRunner(new BookService(db, inject(log)), new BookImportService(db, inject(log))));
      expect(await db.select().from(books)).toHaveLength(1);
      expect(await db.select().from(importJobs)).toHaveLength(1);
      const [done] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(done!.disposition).toBe('accepted');
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.acceptedCount).toBe(1);
    });

    it('crash AFTER the disposition write rolls back book+job+disposition (no orphan); re-drive completes once (F35)', async () => {
      const bs = new BookService(db, inject(log));
      const runner = makeRunner(bs);
      // Fail maybeComplete (runs immediately after the CAS disposition write, inside the tx).
      vi.spyOn(runner as unknown as { maybeComplete: (...a: unknown[]) => Promise<void> }, 'maybeComplete').mockRejectedValueOnce(new Error('crash after disposition'));
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      await crashOnce(runner);

      expect(await db.select().from(books)).toHaveLength(0);
      expect(await db.select().from(importJobs)).toHaveLength(0);
      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('pending'); // disposition write rolled back with the tx

      await drainRunner(makeRunner(new BookService(db, inject(log))));
      expect(await db.select().from(books)).toHaveLength(1);
      const [done] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(done!.disposition).toBe('accepted');
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.acceptedCount).toBe(1);
    });

    it('emits info log, genre telemetry, one book_added event, and a worker nudge after an accepted commit (F39)', async () => {
      const bs = new BookService(db, inject(log));
      const genreSpy = vi.spyOn(bs, 'trackUnmatchedGenres').mockResolvedValue(undefined);
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      await drainRunner(makeRunner(bs));

      expect(genreSpy).toHaveBeenCalledTimes(1);
      expect(eventCreate).toHaveBeenCalledTimes(1);
      expect(eventCreate.mock.calls[0]![0]).toMatchObject({ eventType: 'book_added', source: 'manual' });
      expect(nudge).toHaveBeenCalled(); // import-worker nudge
      expect(log.info as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({ submissionId: subId, bookId: expect.any(Number) }),
        expect.stringContaining('accepted'),
      );
    });

    it('best-effort side-effect rejections (telemetry/event) do not fail the accepted item or block later items (F39)', async () => {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'trackUnmatchedGenres').mockRejectedValue(new Error('telemetry down'));
      eventCreate.mockRejectedValue(new Error('event down'));
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);

      await drainRunner(makeRunner(bs));

      // Both items still accepted with books/jobs; the header still completes — failures isolated.
      const rows = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
      expect(rows.every((r) => r.disposition === 'accepted')).toBe(true);
      expect(await db.select().from(books)).toHaveLength(2);
      expect(await db.select().from(importJobs)).toHaveLength(2);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.acceptedCount).toBe(2);
    });

    it('resolves provider ASIN enrichment BEFORE opening the accepted-item transaction (F40)', async () => {
      let releaseProvider!: (v: { asin: string }) => void;
      const providerGate = new Promise<{ asin: string }>((res) => { releaseProvider = res; });
      const metadataService = { getBook: vi.fn().mockReturnValue(providerGate) };
      const bs = new BookService(db, inject(log), metadataService as never);
      const txSpy = vi.spyOn(db, 'transaction');
      const runner = makeRunner(bs);
      // A providerId but NO asin forces resolveCreateInput to call the provider.
      const item: StagedImportItem = { path: '/a', title: 'A', forceImport: true, metadata: { title: 'A', authors: [{ name: 'X' }], providerId: 'prov-1' } };
      const subId = await seedProcessing([item]);

      const drainP = drainRunner(runner);
      await waitFor(() => (metadataService.getBook as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      // The accepted-item transaction must NOT open while provider I/O is still in flight.
      expect(txSpy).not.toHaveBeenCalled();

      releaseProvider({ asin: 'B0PROV1' });
      await drainP;

      expect(txSpy).toHaveBeenCalled(); // tx opened only after enrichment settled
      const [row] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(row!.disposition).toBe('accepted');
      txSpy.mockRestore();
    });

    it('persists manual copy AND move mode through the FULL createSubmission→PUT→finalize→runner flow; library omits it (F48)', async () => {
      const staging = new ImportStagingService(db, inject(log), () => { /* runner nudge no-op — driven manually */ });

      async function runFlow(source: 'library' | 'manual', mode: 'copy' | 'move' | undefined, path: string): Promise<void> {
        const item = acceptedItem(path, path);
        const clientSubmissionId = randomUUID();
        const digest = createHash('sha256')
          .update(serializeSubmissionForDigest({ source, ...(mode ? { mode } : {}), items: [item] }))
          .digest('hex');
        await staging.createSubmission({ source, ...(mode ? { mode } : {}), clientSubmissionId, payloadDigest: digest, expectedCount: 1 } as never);
        const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.clientSubmissionId, clientSubmissionId));
        await staging.putItems(hdr!.id, { items: [{ ordinal: 0, item }] });
        await staging.finalize(hdr!.id); // real digest verification over the persisted mode
        // The persisted header carries the exact source/mode.
        const [afterFinalize] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, hdr!.id));
        expect(afterFinalize!.source).toBe(source);
        expect(afterFinalize!.mode).toBe(mode ?? null);
        await drainRunner(makeRunner(new BookService(db, inject(log))));
      }

      await runFlow('manual', 'copy', '/manual-copy');
      await runFlow('manual', 'move', '/manual-move');
      await runFlow('library', undefined, '/lib48');

      const jobs = await db.select().from(importJobs);
      const jobFor = (p: string) => jobs.find((j) => JSON.parse(j.metadata as string).path === p);
      expect(JSON.parse(jobFor('/manual-copy')!.metadata as string).mode).toBe('copy');
      expect(JSON.parse(jobFor('/manual-move')!.metadata as string).mode).toBe('move');
      expect('mode' in JSON.parse(jobFor('/lib48')!.metadata as string)).toBe(false); // pointer-mode fallback
    });

    it('a post-commit book lookup failure does not suppress the worker nudge; item stays accepted and processing continues (F49)', async () => {
      const bs = new BookService(db, inject(log));
      // The FIRST accepted item's post-commit getById rejects; the second succeeds.
      vi.spyOn(bs, 'getById').mockRejectedValueOnce(new Error('book lookup boom'));
      (log.warn as ReturnType<typeof vi.fn>).mockClear();
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);

      await drainRunner(makeRunner(bs));

      const rows = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
      expect(rows[0]!.disposition).toBe('accepted'); // already committed — the lookup failure can't undo it
      expect(rows[1]!.disposition).toBe('accepted'); // processing continued to the later item
      // The worker nudge fired for BOTH accepted items — including the lookup-failed one
      // (the OLD unguarded code would nudge only once, deferring the first to the safety poll).
      expect(nudge).toHaveBeenCalledTimes(2);
      // The lookup failure is a serialized best-effort diagnostic.
      expect(log.warn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'book lookup boom' }), submissionId: subId, ordinal: 0 }),
        expect.stringContaining('book lookup failed'),
      );
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.acceptedCount).toBe(2);
    });

    it('nudges the import worker EXACTLY once per accepted item (F45 cardinality)', async () => {
      await seedProcessing([acceptedItem('/a', 'A')]);
      await drainRunner(makeRunner(new BookService(db, inject(log))));
      expect(nudge).toHaveBeenCalledTimes(1); // one accepted → one nudge

      nudge.mockClear();
      await seedProcessing([acceptedItem('/b', 'B'), acceptedItem('/c', 'C'), acceptedItem('/d', 'D')]);
      await drainRunner(makeRunner(new BookService(db, inject(log))));
      expect(nudge).toHaveBeenCalledTimes(3); // three accepted → exactly three nudges
    });

    it('serializes telemetry and event failures into diagnostic logs (F45)', async () => {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'trackUnmatchedGenres').mockRejectedValue(new Error('telemetry boom'));
      eventCreate.mockRejectedValue(new Error('event boom'));
      (log.debug as ReturnType<typeof vi.fn>).mockClear();
      (log.warn as ReturnType<typeof vi.fn>).mockClear();
      await seedProcessing([acceptedItem('/a', 'A')]);

      await drainRunner(makeRunner(bs));

      // The best-effort .catch handlers log the SERIALIZED errors (debug for telemetry, warn for event).
      await waitFor(() => (log.debug as ReturnType<typeof vi.fn>).mock.calls.length > 0 && (log.warn as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      expect(log.debug as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'telemetry boom' }) }),
        expect.stringContaining('genres'),
      );
      expect(log.warn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'event boom' }) }),
        expect.stringContaining('book_added'),
      );
      // The item still committed as accepted despite the best-effort failures.
      expect((await db.select().from(books))).toHaveLength(1);
    });
  });

  // ── #1894: import_run_finished dispatch on the winning terminal CAS ───────
  describe('completion notification (#1894)', () => {
    it('dispatches import_run_finished exactly once with source + terminal counts on completion', async () => {
      // Two null payloads → both fail validation → terminal 'failed' → completes.
      const subId = await seedProcessing([null, null], { source: 'library' });
      await drainAll();
      const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(hdr!.status).toBe('complete');
      expect(notifyStub).toHaveBeenCalledTimes(1);
      expect(notifyStub).toHaveBeenCalledWith('import_run_finished', {
        event: 'import_run_finished',
        submission: { source: 'library', status: 'complete', counts: { accepted: 0, held: 0, skipped: 0, failed: 2 } },
      });
    });

    it('does not re-fire on a redundant re-drain of an already-complete submission', async () => {
      await seedProcessing([null], { source: 'manual', mode: 'move' });
      await drainAll();
      expect(notifyStub).toHaveBeenCalledTimes(1);
      notifyStub.mockClear();
      await drainAll(); // nothing 'processing' remains → no completion, no re-fire
      expect(notifyStub).not.toHaveBeenCalled();
    });

    // Seed a 'processing' header whose items are ALREADY terminal (no pending) — the
    // boot/no-pending completion path (drainOne's maybeComplete).
    async function seedProcessingNoPending(dispositions: ('skipped' | 'held' | 'failed')[]): Promise<number> {
      const [sub] = await db.insert(importSubmissions).values({
        clientSubmissionId: randomUUID(), payloadDigest: 'a'.repeat(64), source: 'library',
        expectedCount: dispositions.length, status: 'processing', receivedCount: dispositions.length,
      }).returning();
      for (let i = 0; i < dispositions.length; i++) {
        await db.insert(importSubmissionItems).values({
          submissionId: sub!.id, ordinal: i, path: `/p${i}`, title: `T${i}`,
          disposition: dispositions[i]!, reason: dispositions[i] === 'skipped' ? 'already-in-library' : null,
        });
      }
      return sub!.id;
    }

    it('dispatches exactly once on the ACCEPTED-item completion path (F13)', async () => {
      const subId = await seedProcessing([acceptedItem('/a', 'A')], { source: 'manual', mode: 'copy' });
      await drainAll();
      const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(hdr!.status).toBe('complete');
      expect(notifyStub).toHaveBeenCalledTimes(1);
      expect(notifyStub).toHaveBeenCalledWith('import_run_finished', {
        event: 'import_run_finished',
        submission: { source: 'manual', status: 'complete', counts: { accepted: 1, held: 0, skipped: 0, failed: 0 } },
      });
    });

    it('dispatches exactly once on the boot/no-pending completion path via public start() auto-resume (F13)', async () => {
      const subId = await seedProcessingNoPending(['skipped', 'held']);
      const r = makeRunner(new BookService(db, inject(log)));
      r.start();
      await waitFor(isComplete(subId));
      await r.stop();
      expect(notifyStub).toHaveBeenCalledTimes(1);
      expect(notifyStub).toHaveBeenCalledWith('import_run_finished', {
        event: 'import_run_finished',
        submission: { source: 'library', status: 'complete', counts: { accepted: 0, held: 1, skipped: 1, failed: 0 } },
      });
    });

    it('dispatch is strictly POST-COMMIT — proven via a SEPARATE connection that sees only committed data (F33/F14)', async () => {
      const subId = await seedProcessing([null], { source: 'library' });
      // A distinct connection to the same file sees ONLY committed state. If the
      // dispatch were moved inside the completion transaction (pre-commit), this
      // read would still observe the pre-completion status — so 'complete' here is
      // deletion-proof evidence that notify fires only after the tx promise resolves.
      const observer = createDb(dbFile);
      let statusSeenBySeparateConn: string | undefined;
      notifyStub.mockImplementation(async () => {
        const [h] = await observer.select().from(importSubmissions).where(eq(importSubmissions.id, subId)).limit(1);
        statusSeenBySeparateConn = h?.status;
      });
      await drainAll();
      expect(notifyStub).toHaveBeenCalledTimes(1);
      expect(statusSeenBySeparateConn).toBe('complete'); // committed before dispatch
      observer.$client.close();
    });

    it('a rejected notifier dispatch leaves the header complete and does not stall later submissions (F14)', async () => {
      const first = await seedProcessing([null], { source: 'library' });
      const second = await seedProcessing([null], { source: 'manual', mode: 'copy' });
      notifyStub.mockRejectedValueOnce(new Error('notify lookup boom')); // first completion's dispatch rejects
      await drainAll();
      const [h1] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, first));
      const [h2] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, second));
      expect(h1!.status).toBe('complete'); // rejection isolated — header stays complete
      expect(h2!.status).toBe('complete'); // later submission still drained
      expect(notifyStub).toHaveBeenCalledTimes(2);
    });
  });

  // ── F10: public runner lifecycle & concurrency ───────────────────────────
  describe('lifecycle & concurrency (F10)', () => {
    it('start() boot-resumes a processing submission to completion via the public drain loop', async () => {
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);
      const r = makeRunner(new BookService(db, inject(log)));
      r.start();
      await waitFor(isComplete(subId));
      await r.stop();

      expect(await db.select().from(books)).toHaveLength(2);
      expect(await db.select().from(importJobs)).toHaveLength(2);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.acceptedCount).toBe(2);
    });

    it('repeated nudges during processing coalesce — each ordinal is processed exactly once', async () => {
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);
      const r = makeRunner(new BookService(db, inject(log)));
      r.start();
      r.nudge(); r.nudge(); r.nudge();
      await waitFor(isComplete(subId));
      await r.stop();

      // Coalescing → no duplicate books/jobs despite the nudge storm.
      expect(await db.select().from(books)).toHaveLength(2);
      expect(await db.select().from(importJobs)).toHaveLength(2);
    });

    it('two runners over SEPARATE connections process each ordinal at most once (CAS ≤1 per ordinal)', async () => {
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B'), acceptedItem('/c', 'C')]);
      // Each runner gets its OWN connection to the same file — real multi-process
      // contention, where SQLite file locking rolls back the losing writer cleanly.
      const db2 = createDb(dbFile);
      const r1 = makeRunner(new BookService(db, inject(log)));
      const r2 = makeRunnerWithDb(db2);
      r1.start();
      r2.start();
      // Keep both alive through transient lock-losses by re-nudging while we wait; the
      // CAS backstop still guarantees each ordinal is processed at most once.
      await waitFor(async () => {
        r1.nudge();
        r2.nudge();
        return isComplete(subId)();
      }, 10_000);
      await Promise.all([r1.stop(), r2.stop()]);
      db2.$client.close();

      const items = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
      expect(items.every((i) => i.disposition !== 'pending')).toBe(true); // all terminal
      const acceptedCount = items.filter((i) => i.disposition === 'accepted').length;
      // The CAS on disposition='pending' + rollback guarantees ≤1 book/job per ordinal:
      // a losing racer's placeholder insert rolls back, so book count never exceeds the
      // accepted count (no ordinal double-processed).
      expect(await db.select().from(books)).toHaveLength(acceptedCount);
      expect(await db.select().from(importJobs)).toHaveLength(acceptedCount);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
      expect(h!.acceptedCount).toBe(acceptedCount);
    });

    it('graceful stop awaits the in-flight per-item transaction (F72 mirror)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      const bs = new BookService(db, inject(log));
      const originalResolve = bs.resolveCreateInput.bind(bs);
      vi.spyOn(bs, 'resolveCreateInput').mockImplementationOnce(async (data) => { await gate; return originalResolve(data); });
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      const r = makeRunner(bs);
      r.start();
      // Wait until the drain has entered the item and parked at the gate.
      await waitFor(() => (bs.resolveCreateInput as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);

      const stopP = r.stop(); // sets stopping, then awaits the launched drain
      release(); // let the parked item finish its tx
      await stopP;

      // If stop() did NOT await the launched drain, it would return before the tx
      // committed and this row would still be `pending`.
      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('accepted');
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
    });

    it('recovers on the next safety poll after a drain-level failure, without a restart (F19)', async () => {
      vi.useFakeTimers();
      try {
        const subId = await seedProcessing([acceptedItem('/a', 'A')]); // a 'processing' row exists up-front
        const r = makeRunner(new BookService(db, inject(log)));
        // Inject a ONE-SHOT drain-level failure: the first drainOne's submission SELECT
        // throws, bubbling to runDrain's catch. The item must be left pending (not failed)
        // and the drain must NOT wedge (drainInProgress/runDrainPromise reset).
        const selectSpy = vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('transient drain blip'); });
        r.start();
        await vi.advanceTimersByTimeAsync(50);

        expect(selectSpy).toHaveBeenCalled(); // the blip fired
        const [afterFail] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
        expect(afterFail!.disposition).toBe('pending'); // failure left it pending, not terminal
        const [hdrFail] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
        expect(hdrFail!.status).toBe('processing'); // still awaiting processing

        // The safety poll re-drives WITHOUT a restart and completes it.
        await vi.advanceTimersByTimeAsync(31_000);
        await advanceUntil(isComplete(subId));
        const [done] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
        expect(done!.status).toBe('complete');
        expect(await db.select().from(books)).toHaveLength(1);
        await r.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── #1921: spec-named forced-import concurrency pins (AC2/AC3) ─────────────
  // Sequential runner-boundary pins driven by the direct `drainOne` seam (AC4): no
  // interleaving gate, no lifecycle timer loop, no wall-clock waits — `drainAll` just
  // drains the two seeded 'processing' headers one pending item at a time.
  describe('forced-import staged dispositions (AC2/AC3, #1921)', () => {
    function forcedItem(path: string, title: string, asin?: string): StagedImportItem {
      return { path, title, forceImport: true, metadata: { title, authors: [{ name: 'Author' }], ...(asin ? { asin } : {}) } };
    }

    it('two forced re-confirms resolving to the SAME non-null ASIN → exactly [accepted, skipped(already-in-library)]; one book+job, both headers complete, no drop (AC2)', async () => {
      // Two tabs re-confirm the same held row (forceImport bypasses classification) whose
      // resolved ASIN is the SAME non-null value in both and distinct from any incumbent —
      // no book with this ASIN is seeded, so the winner is decided at the create-time unique
      // index, not confirm-time classification.
      const subA = await seedProcessing([forcedItem('/tabA', 'Shared Book', 'B0SHARED1')]);
      const subB = await seedProcessing([forcedItem('/tabB', 'Shared Book', 'B0SHARED1')]);

      await drainAll();

      // Exactly one book placeholder + one manual job — the ASIN unique index fenced the
      // duplicate registration; the losing tx rolled back.
      expect(await db.select().from(books)).toHaveLength(1);
      const jobs = await db.select().from(importJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.type).toBe('manual');

      // The two item rows carry EXACTLY [accepted, skipped] — never a duplicate registration,
      // never a silent drop (both terminal, neither left pending).
      const rows = await db.select().from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, subA))
        .then(async (a) => [...a, ...await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subB))]);
      expect(rows.every((r) => r.disposition !== 'pending')).toBe(true);
      expect(rows.map((r) => r.disposition).sort()).toEqual(['accepted', 'skipped']);
      const accepted = rows.find((r) => r.disposition === 'accepted')!;
      const skipped = rows.find((r) => r.disposition === 'skipped')!;
      expect(skipped.reason).toBe('already-in-library');
      expect(skipped.existingBookId).toBe(accepted.bookId); // the skip points at the ONE registered book

      const [hA] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subA));
      const [hB] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subB));
      expect(hA!.status).toBe('complete');
      expect(hB!.status).toBe('complete');
    });

    it('two fresh forced null-ASIN submissions of the same book → both accepted, two books, two pending manual jobs (AC3 null-ASIN fence-gap pin)', async () => {
      // NULL-ASIN FENCE-GAP PIN: the partial ASIN unique index (src/db/schema.ts:116-124) only
      // applies where `asin IS NOT NULL`, so confirm-time dedup CANNOT fence duplicate null-ASIN
      // forced imports. Force bypasses classification and NO providerId means resolveCreateInput
      // (src/server/services/book.service.ts:276-294) leaves the resolved ASIN null — so both
      // rows create a DISTINCT book (per-bookId active-job index, src/db/schema.ts:477-481) and
      // both jobs enqueue. This pins the current behavior so any future change is a visible decision.
      const subA = await seedProcessing([forcedItem('/dup', 'Dup Book')]);
      const subB = await seedProcessing([forcedItem('/dup', 'Dup Book')]);

      await drainAll();

      // Two distinct null-ASIN books and two pending manual jobs — the fence gap admits both.
      const bookRows = await db.select().from(books);
      expect(bookRows).toHaveLength(2);
      expect(bookRows.every((b) => b.asin == null)).toBe(true);
      const jobs = await db.select().from(importJobs);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.status === 'pending' && j.type === 'manual')).toBe(true);

      // Both item rows accepted — none held/skipped/failed — and both headers complete.
      const rows = await db.select().from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, subA))
        .then(async (a) => [...a, ...await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subB))]);
      expect(rows.every((r) => r.disposition === 'accepted')).toBe(true);
      const [hA] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subA));
      const [hB] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subB));
      expect(hA!.status).toBe('complete');
      expect(hB!.status).toBe('complete');
    });
  });

  // #1925: within-scan title collisions no longer hard-flag at scan time — both folders flow
  // through as NON-forced confirm items in ONE submission. The runner processes them in ascending
  // ordinal, committing the first before classifying the second, so the SECOND item's
  // classifyConfirmItem → findDuplicate → resolveRecordingIdentity runs over the matched metadata
  // both rows carry (persisted onto the first's placeholder via buildBookCreatePayload). These pin
  // the three confirm-ladder outcomes; none uses forceImport (the decision must reach the ladder).
  describe('within-scan sibling confirm-ladder outcomes (#1925 AC6/AC7)', () => {
    /** A NON-forced staged item whose matched metadata carries the identity signals the ladder reads. */
    function ladderItem(
      path: string,
      title: string,
      opts: { author?: string; narrators?: string[]; asin?: string; duration?: number } = {},
    ): StagedImportItem {
      const author = opts.author ?? 'J.K. Rowling';
      return {
        path,
        title,
        authorName: author,
        ...(opts.narrators ? { narrators: opts.narrators } : {}),
        ...(opts.asin ? { asin: opts.asin } : {}),
        metadata: {
          title,
          authors: [{ name: author }],
          ...(opts.narrators ? { narrators: opts.narrators } : {}),
          ...(opts.asin ? { asin: opts.asin } : {}),
          ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
        },
      };
    }

    async function orderedItems(subId: number) {
      return db.select().from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, subId))
        .orderBy(asc(importSubmissionItems.ordinal));
    }

    it('AC6 same-edition decisive signal (equal canonical ASIN): first imports, second → same-recording skip; ONE book', async () => {
      const subId = await seedProcessing([
        ladderItem('/hp/a', 'Harry Potter', { narrators: ['Jim Dale'], asin: 'B0EQUALASIN' }),
        ladderItem('/hp/b', 'Harry Potter', { narrators: ['Jim Dale'], asin: 'B0EQUALASIN' }),
      ]);

      await drainAll();

      const rows = await orderedItems(subId);
      expect(rows[0]!.disposition).toBe('accepted');
      expect(rows[1]!.disposition).toBe('skipped');
      expect(rows[1]!.reason).toBe('already-in-library');
      // The skip carries the incumbent id+title → surfaced as "already in your library as '{title}'".
      expect(rows[1]!.existingBookId).toBe(rows[0]!.bookId);
      expect(rows[1]!.existingTitle).toBe('Harry Potter');
      // Never two identical books — one imported, one skipped-with-report.
      expect(await db.select().from(books)).toHaveLength(1);
    });

    it('AC6 no usable identity signal (title+author only, no narrator/ASIN): first imports, second → review held; ONE book, ONE held', async () => {
      const subId = await seedProcessing([
        ladderItem('/hp/a', 'Harry Potter', { narrators: ['Jim Dale'] }),
        ladderItem('/hp/b', 'Harry Potter'), // no narrator or ASIN signal on the comparison
      ]);

      await drainAll();

      const rows = await orderedItems(subId);
      expect(rows[0]!.disposition).toBe('accepted');
      expect(rows[1]!.disposition).toBe('held');
      expect(rows[1]!.reason).toBe('recording-review-required');
      // One imported, one held (NOT skipped, NOT a second import).
      expect(await db.select().from(books)).toHaveLength(1);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.acceptedCount).toBe(1);
      expect(h!.heldCount).toBe(1);
    });

    it('AC7 distinct editions (single narrator vs NAMED full-cast, unequal ASINs): both import; TWO books', async () => {
      const subId = await seedProcessing([
        ladderItem('/hp/a', 'Harry Potter', { narrators: ['Jim Dale'], asin: 'B0JIMDALE' }),
        // Named full-cast members — NOT the literal "Full Cast" placeholder — so the sets compare not-equal.
        ladderItem('/hp/b', 'Harry Potter', { narrators: ['Hugh Laurie', 'Cush Jumbo'], asin: 'B0FULLCAST' }),
      ]);

      await drainAll();

      const rows = await orderedItems(subId);
      expect(rows.every((r) => r.disposition === 'accepted')).toBe(true);
      // different-recording for the second row → both import as distinct editions (#1712).
      expect(await db.select().from(books)).toHaveLength(2);
    });

    it('AC7 negative control (Tehanu shape — different ASIN, EQUAL narrator): second → same-recording skip; ONE book', async () => {
      // A distinct matched ASIN ALONE does not yield two books: unequal ASINs defer to the narrator
      // ladder, and an equal narrator (with agreeing duration) resolves same-recording → skip.
      const subId = await seedProcessing([
        ladderItem('/te/a', 'Tehanu', { author: 'Ursula K. Le Guin', narrators: ['Jenny Sterlin'], asin: 'B0OLDTEHANU', duration: 420 }),
        ladderItem('/te/b', 'Tehanu', { author: 'Ursula K. Le Guin', narrators: ['Jenny Sterlin'], asin: 'B0NEWTEHANU', duration: 420 }),
      ]);

      await drainAll();

      const rows = await orderedItems(subId);
      expect(rows[0]!.disposition).toBe('accepted');
      expect(rows[1]!.disposition).toBe('skipped');
      expect(rows[1]!.reason).toBe('already-in-library');
      expect(await db.select().from(books)).toHaveLength(1);
    });
  });

  // ── #2158: the metadata.opf overlay ──────────────────────────────────────
  //
  // The runner half of the ladder: read the sidecar at the SOURCE folder, fold it into the staged
  // item BEFORE classification, and carry the narrator provenance on the enqueued job payload. The
  // tag/provider half (which needs the manual adapter) lives in `import-opf-ladder.integration.test.ts`.
  describe('metadata.opf overlay (#2158)', () => {
    /** A book folder under the suite tmpdir, optionally holding a `metadata.opf`. */
    function bookFolder(name: string, opf?: string): string {
      const folder = join(dir, name);
      mkdirSync(folder, { recursive: true });
      if (opf !== undefined) writeFileSync(join(folder, 'metadata.opf'), opf, 'utf-8');
      return folder;
    }

    function opfWith(inner: string[]): string {
      return [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
        ...inner.map((line) => `    ${line}`),
        '  </metadata>',
        '</package>',
        '',
      ].join('\n');
    }

    const DESCRIPTIVE_OPF = opfWith([
      '<dc:title>Opf Title</dc:title>',
      '<dc:subtitle>Opf Subtitle</dc:subtitle>',
      '<dc:description>Opf Description</dc:description>',
      '<dc:publisher>Opf Publisher</dc:publisher>',
      '<dc:date>1988-08-08</dc:date>',
      '<dc:subject>Opf Genre</dc:subject>',
    ]);

    async function jobPayload(): Promise<Record<string, unknown>> {
      const [job] = await db.select().from(importJobs);
      return JSON.parse(job!.metadata) as Record<string, unknown>;
    }

    async function onlyBook() {
      const rows = await db.select().from(books);
      expect(rows).toHaveLength(1);
      return rows[0]!;
    }

    async function bookAuthorNames(bookId: number): Promise<string[]> {
      const detail = await new BookService(db, inject(log)).getById(bookId);
      return (detail?.authors ?? []).map((a) => a.name);
    }

    // ── AC10: folder-parse priority survives the overlay ──────────────────

    it('AC10: an OPF title/series never overrides the folder parse', async () => {
      const path = bookFolder('ac10-folder', opfWith([
        '<dc:title>Opf Title</dc:title>',
        '<meta name="calibre:series" content="Opf Series"/>',
        '<meta name="calibre:series_index" content="9"/>',
      ]));
      await seedProcessing([{ path, title: 'Folder Title', seriesName: 'Folder Series', seriesPosition: 2, forceImport: true }]);

      await drainAll();

      expect(await onlyBook()).toMatchObject({ title: 'Folder Title', seriesName: 'Folder Series', seriesPosition: 2 });
    });

    it('AC10: an item with NO series takes the OPF series', async () => {
      const path = bookFolder('ac10-noseries', opfWith([
        '<meta name="calibre:series" content="Opf Series"/>',
        '<meta name="calibre:series_index" content="0"/>',
      ]));
      await seedProcessing([{ path, title: 'Folder Title', forceImport: true }]);

      await drainAll();

      // seriesPosition 0 is a legitimate position, so it must survive the whole chain.
      expect(await onlyBook()).toMatchObject({ seriesName: 'Opf Series', seriesPosition: 0 });
    });

    it('AC10 headline: TWO OPF aut creators against a single folder author keep the FOLDER author', async () => {
      // Two creators is what forces the branch: `buildBookCreatePayload` prefers `meta.authors`
      // outright when it holds MORE THAN ONE, so a one-creator fixture would pass against an overlay
      // that writes `metadata.authors` unconditionally (`roundtrip-fixture-must-force-the-branch`).
      // A provider match with exactly ONE author is required too — with `metadata` absent the
      // overlay takes the synthetic path and never reaches the constrained write at all.
      const path = bookFolder('ac10-two-aut', opfWith([
        '<dc:creator opf:role="aut">Opf Author One</dc:creator>',
        '<dc:creator opf:role="aut">Opf Author Two</dc:creator>',
      ]));
      await seedProcessing([{
        path, title: 'T', authorName: 'Folder Author', forceImport: true,
        metadata: { title: 'T', authors: [{ name: 'Provider Author' }] },
      }]);

      await drainAll();

      expect(await bookAuthorNames((await onlyBook()).id)).toEqual(['Folder Author']);
    });

    it('AC10: an OPF series never overrides a series the PROVIDER supplied', async () => {
      // The folder-carried fields are corroborated, never overridden — for the provider as well as
      // for the folder parse. Reds against an overlay that writes `seriesPrimary` unconditionally.
      const path = bookFolder('ac10-provider-series', opfWith([
        '<meta name="calibre:series" content="Opf Series"/>',
        '<meta name="calibre:series_index" content="9"/>',
      ]));
      await seedProcessing([{
        path, title: 'T', forceImport: true,
        metadata: { title: 'T', authors: [{ name: 'A' }], seriesPrimary: { name: 'Provider Series', position: 5 } },
      }]);

      await drainAll();

      expect(await onlyBook()).toMatchObject({ seriesName: 'Provider Series', seriesPosition: 5 });
    });

    it('AC10: provider authors present + no folder author → the provider authors survive', async () => {
      const path = bookFolder('ac10-provider-aut', opfWith([
        '<dc:creator opf:role="aut">Opf Author One</dc:creator>',
        '<dc:creator opf:role="aut">Opf Author Two</dc:creator>',
      ]));
      await seedProcessing([{ path, title: 'T', forceImport: true, metadata: { title: 'T', authors: [{ name: 'Provider Author' }] } }]);

      await drainAll();

      expect(await bookAuthorNames((await onlyBook()).id)).toEqual(['Provider Author']);
    });

    it('AC10: neither present → the OPF creators land', async () => {
      const path = bookFolder('ac10-opf-aut', opfWith([
        '<dc:creator opf:role="aut">Opf Author One</dc:creator>',
        '<dc:creator opf:role="aut">Opf Author Two</dc:creator>',
      ]));
      await seedProcessing([{ path, title: 'T', forceImport: true }]);

      await drainAll();

      expect(await bookAuthorNames((await onlyBook()).id)).toEqual(['Opf Author One', 'Opf Author Two']);
    });

    // ── AC11: an OPF ASIN is a last resort for identity ───────────────────

    describe('AC11 — identity', () => {
      const OPF_ASIN = opfWith(['<dc:identifier opf:scheme="ASIN">B0OPFASIN1</dc:identifier>']);

      /** Drain with a spied `findDuplicate` and return the candidate it was handed. */
      async function dedupeCandidate(item: StagedImportItem): Promise<Record<string, unknown>> {
        const bs = new BookService(db, inject(log));
        const spy = vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false } as never);
        await seedProcessing([item]);
        await drainRunner(makeRunner(bs));
        expect(spy).toHaveBeenCalledTimes(1);
        return spy.mock.calls[0]![0] as unknown as Record<string, unknown>;
      }

      it('(i) an explicit item ASIN wins over the OPF one', async () => {
        const path = bookFolder('ac11-item', OPF_ASIN);
        expect(await dedupeCandidate({ path, title: 'T', asin: 'B0ITEMASIN' })).toMatchObject({ asin: 'B0ITEMASIN' });
      });

      it('(ii) a matched provider ASIN wins over the OPF one', async () => {
        const path = bookFolder('ac11-provider', OPF_ASIN);
        const item: StagedImportItem = { path, title: 'T', metadata: { title: 'T', authors: [{ name: 'A' }], asin: 'B0PROVASIN' } };
        expect(await dedupeCandidate(item)).toMatchObject({ asin: 'B0PROVASIN' });
      });

      it('(iii) an OPF ASIN alone reaches findDuplicate', async () => {
        const path = bookFolder('ac11-opf', OPF_ASIN);
        expect(await dedupeCandidate({ path, title: 'T' })).toMatchObject({ asin: 'B0OPFASIN1' });
      });

      it('(iv) a 65-char OPF ASIN was dropped at read time, so findDuplicate receives none', async () => {
        const path = bookFolder('ac11-overbound', opfWith([
          `<dc:identifier opf:scheme="ASIN">${'x'.repeat(65)}</dc:identifier>`,
          '<dc:title>Anchor</dc:title>',
        ]));
        expect(await dedupeCandidate({ path, title: 'T' })).not.toHaveProperty('asin');
      });
    });

    // ── AC12: a synthetic BookMetadata when there was no provider match ────

    it('AC12: no provider match + an OPF → the row gets the OPF descriptive fields', async () => {
      const path = bookFolder('ac12-synth', DESCRIPTIVE_OPF);
      await seedProcessing([{ path, title: 'Folder Title', authorName: 'Folder Author', forceImport: true }]);

      await drainAll();

      const book = await onlyBook();
      expect(book).toMatchObject({
        title: 'Folder Title', subtitle: 'Opf Subtitle', description: 'Opf Description',
        publisher: 'Opf Publisher', publishedDate: '1988-08-08',
      });
      expect(book.genres).toEqual(['Opf Genre']);
      // The synthetic metadata is real on the payload, and its authors follow AC10's table.
      const payload = await jobPayload();
      expect(payload.metadata).toMatchObject({ title: 'Folder Title', authors: [{ name: 'Folder Author' }] });
    });

    it('AC12: no provider match + no OPF → item.metadata stays undefined on the enqueued payload', async () => {
      const path = bookFolder('ac12-none');
      await seedProcessing([{ path, title: 'Folder Title', forceImport: true }]);

      await drainAll();

      expect(await jobPayload()).not.toHaveProperty('metadata');
    });

    it('the OPF OVERRIDES a provider match for the descriptive fields', async () => {
      const path = bookFolder('descriptive-override', DESCRIPTIVE_OPF);
      await seedProcessing([{
        path, title: 'Folder Title', forceImport: true,
        metadata: {
          title: 'Provider Title', authors: [{ name: 'A' }], subtitle: 'Provider Subtitle',
          description: 'Provider Description', publisher: 'Provider Publisher',
          publishedDate: '2020-01-01', genres: ['Provider Genre'],
        },
      }]);

      await drainAll();

      const book = await onlyBook();
      expect(book).toMatchObject({
        subtitle: 'Opf Subtitle', description: 'Opf Description',
        publisher: 'Opf Publisher', publishedDate: '1988-08-08',
      });
      expect(book.genres).toEqual(['Opf Genre']);
    });

    // ── AC13: nothing about a bad OPF can fail an import ──────────────────

    it.each([
      ['binary-garbage', '\x00\x01not xml\u00ff'],
      ['an-unparseable-fragment', '<package><metadata><dc:title>unclosed'],
      ['a-valid-but-empty-document', '<package><metadata></metadata></package>'],
    ])('AC13: %s produces the no-OPF baseline outcome', async (label, contents) => {
      const path = bookFolder(`ac13-${label}`, contents);
      const subId = await seedProcessing([{ path, title: 'Folder Title', forceImport: true, metadata: { title: 'P', authors: [{ name: 'A' }], description: 'Provider Description' } }]);

      await drainAll();

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('accepted');
      expect(await onlyBook()).toMatchObject({ description: 'Provider Description' });
    });

    // ── D1: the overlay runs BEFORE classification ────────────────────────

    it('D1: OPF narrators are visible to classifyConfirmItem', async () => {
      const path = bookFolder('d1-order', opfWith(['<dc:creator opf:role="nrt">Opf Narrator</dc:creator>']));
      const bs = new BookService(db, inject(log));
      const spy = vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false } as never);
      await seedProcessing([{ path, title: 'T' }]);

      await drainRunner(makeRunner(bs));

      // Reds if the overlay moves after classification: the confirm-time recording verdict would go
      // back to running narrator-blind.
      expect(spy.mock.calls[0]![0]).toMatchObject({ narrators: ['Opf Narrator'] });
    });

    it('D1: the no-OPF control hands findDuplicate no narrators', async () => {
      const path = bookFolder('d1-control');
      const bs = new BookService(db, inject(log));
      const spy = vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false } as never);
      await seedProcessing([{ path, title: 'T' }]);

      await drainRunner(makeRunner(bs));

      expect(spy.mock.calls[0]![0]).not.toHaveProperty('narrators');
    });

    // ── D2 + the read location ────────────────────────────────────────────

    it('D2: a manual COPY submission reads the OPF at the SOURCE folder', async () => {
      // The regression pin for D2. The manual empty-target fast path stages AUDIO ONLY (#1602), so
      // `metadata.opf` never reaches the library target — a read at the eventual `finalPath` would
      // find nothing for every copy/move import.
      const path = bookFolder('d2-copy-source', DESCRIPTIVE_OPF);
      await seedProcessing([{ path, title: 'T', forceImport: true }], { source: 'manual', mode: 'copy' });

      await drainAll();

      expect(await onlyBook()).toMatchObject({ description: 'Opf Description' });
      expect(await jobPayload()).toMatchObject({ mode: 'copy' });
    });

    it('pointer mode (a library submission, no mode) reads the same single folder', async () => {
      const path = bookFolder('pointer', DESCRIPTIVE_OPF);
      await seedProcessing([{ path, title: 'T', forceImport: true }]);

      await drainAll();

      expect(await onlyBook()).toMatchObject({ description: 'Opf Description' });
      expect(await jobPayload()).not.toHaveProperty('mode');
    });

    it('KNOWN LIMITATION: an OPF at a disc-group PARENT is not read', async () => {
      // For a coalesced disc group `item.path` is a member folder (`import-helpers.ts:501-536`), so a
      // sidecar sitting at the group parent is out of scope. Pinned deliberately rather than left
      // unspecified; lifting it is follow-up work.
      const parent = bookFolder('disc-parent', DESCRIPTIVE_OPF);
      const member = join(parent, 'Disc 1');
      mkdirSync(member, { recursive: true });
      await seedProcessing([{ path: member, title: 'T', forceImport: true }]);

      await drainAll();

      expect(await onlyBook()).toMatchObject({ description: null });
    });

    it('a single-file pointer path (.m4b) is skipped without a read', async () => {
      const path = join(bookFolder('single-file'), 'Book.m4b');
      writeFileSync(path, '');
      await seedProcessing([{ path, title: 'T', forceImport: true }]);

      await drainAll();

      expect(await onlyBook()).toMatchObject({ description: null });
    });

    // ── D8/D3: narratorSource rides the enqueued payload ──────────────────

    it.each([
      ['curated (OPF)', true, undefined, 'curated'],
      ['curated (differing wire narrators)', false, ['Typed'], 'curated'],
      ['provider (wire equals metadata)', false, ['Provider Narrator'], 'provider'],
      ['none (no wire narrators)', false, undefined, 'none'],
    ] as const)('D3/D8: %s lands on the enqueued job payload', async (label, withOpf, narrators, expected) => {
      const path = bookFolder(
        `ns-${expected}-${label.replace(/\W+/g, '-')}`,
        withOpf ? opfWith(['<dc:creator opf:role="nrt">Opf Narrator</dc:creator>']) : undefined,
      );
      await seedProcessing([{
        path, title: 'T', forceImport: true,
        ...(narrators !== undefined && { narrators: [...narrators] }),
        metadata: { title: 'T', authors: [{ name: 'A' }], narrators: ['Provider Narrator'] },
      }]);

      await drainAll();

      // Asserted on the PAYLOAD, so a stripped-at-reparse regression (D3) is caught directly rather
      // than as a confusing downstream symptom — the schema re-parse below is the adapter's own.
      const payload = await jobPayload();
      expect(payload).toMatchObject({ narratorSource: expected });
      expect(manualImportJobPayloadSchema.parse(payload).narratorSource).toBe(expected);
    });
  });
});
