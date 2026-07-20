import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, asc } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, importJobs, importSubmissions, importSubmissionItems } from '../../db/schema.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { BookService } from './book.service.js';
import { BookImportService } from './book-import.service.js';
import { ImportSubmissionRunner } from './import-submission-runner.js';
import type { EventHistoryService } from './event-history.service.js';
import type { StagedImportItem } from '../../core/import-staging/schemas.js';

interface DrainSeam { drainOne(): Promise<boolean> }

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
  const log = createMockLogger();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-'));
    dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    nudge = vi.fn();
    eventCreate = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create: eventCreate } as unknown as EventHistoryService;
    runner = new ImportSubmissionRunner({
      db,
      log: inject(log),
      bookService: new BookService(db, inject(log)),
      bookImportService: new BookImportService(db, inject(log)),
      eventHistory,
      nudgeImportWorker: nudge as unknown as () => void,
    });
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function seedProcessing(items: (StagedImportItem | null)[]): Promise<number> {
    const [sub] = await db.insert(importSubmissions).values({
      clientSubmissionId: `c-${items.length}-${Math.round(performance.now())}`,
      payloadDigest: 'a'.repeat(64), source: 'library', expectedCount: items.length, status: 'processing', receivedCount: items.length,
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
        await vi.advanceTimersByTimeAsync(200);
        const [done] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
        expect(done!.status).toBe('complete');
        expect(await db.select().from(books)).toHaveLength(1);
        await r.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
