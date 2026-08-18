import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, asc } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importJobs, importSubmissions, importSubmissionItems, seriesMembers } from '@db/schema.js';
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
    // Direct drains need `running` set or the F72 pre-claim barrier aborts.
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

  // Uses its own libSQL connection to model multi-process contention.
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

  // Fake timers stall waitFor; advance until observable state settles instead of assuming scheduler timing (#2176).
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
    expect(await db.select().from(books)).toHaveLength(0);
    expect(await db.select().from(importJobs)).toHaveLength(0);
  });

  it('boot-resume: a re-drive never re-processes already-terminal items', async () => {
    const subId = await seedProcessing([acceptedItem('/a', 'A')]);
    await drainAll();
    const booksAfterFirst = await db.select().from(books);
    const jobsAfterFirst = await db.select().from(importJobs);

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
    const [firstBook] = await db.insert(books).values({ publicId: 'pre-book', title: 'A', status: 'importing' }).returning();
    await db.update(importSubmissionItems)
      .set({ disposition: 'accepted', bookId: firstBook!.id })
      .where(eq(importSubmissionItems.ordinal, 0));

    await drainAll();

    const items = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
    expect(items.every((i) => i.disposition === 'accepted')).toBe(true);
    expect(await db.select().from(books)).toHaveLength(2);
    const [header] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
    expect(header!.status).toBe('complete');
    expect(header!.acceptedCount).toBe(2);
  });

  /**
   * #2435 AC5/AC6/AC8/AC26 — attaching a staged item to a fileless incumbent. DB-backed because
   * every property here is about what SURVIVED a rollback, which no mock can observe.
   */
  describe('attach to a fileless incumbent (#2435)', () => {
    async function seedIncumbent(overrides: Record<string, unknown> = {}): Promise<number> {
      const [b] = await db.insert(books).values({
        publicId: `att-${Math.round(performance.now())}-${Math.random()}`,
        title: 'Incumbent', status: 'wanted', path: null, ...overrides,
      }).returning();
      return b!.id;
    }

    /** `findDuplicate` is the only double: the real decision module and classifier run inside. */
    function bookServiceReturning(book: Record<string, unknown>): BookService {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'same-recording', book: book as never, hasIncumbent: true });
      return bs;
    }

    const stagedItem = () => ({ path: '/staging/A', title: 'Offered Title', metadata: { title: 'Offered Title', authors: [{ name: 'X' }] } });

    it('enqueues against the incumbent and creates NO book (AC5)', async () => {
      const incId = await seedIncumbent();
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      const createResolved = vi.spyOn(bs, 'createResolved');
      const resolveCreateInput = vi.spyOn(bs, 'resolveCreateInput');
      const subId = await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      expect(createResolved).not.toHaveBeenCalled();
      expect(resolveCreateInput).not.toHaveBeenCalled();
      expect(await db.select().from(books)).toHaveLength(1);

      const jobs = await db.select().from(importJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.bookId).toBe(incId);
      expect(jobs[0]!.type).toBe('manual');

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('accepted');
      expect(item!.bookId).toBe(incId);
      expect(item!.reason).toBeNull();
    });

    it('carries the source path, the submission mode and the attach marker — and no offered naming (AC5/AC23)', async () => {
      const incId = await seedIncumbent();
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      await seedProcessing([stagedItem()], { source: 'manual', mode: 'move' });

      await drainRunner(makeRunner(bs));

      const [job] = await db.select().from(importJobs);
      const payload = manualImportJobPayloadSchema.parse(JSON.parse(job!.metadata!));
      expect(payload.attach).toBe(true);
      expect(payload.path).toBe('/staging/A');
      expect(payload.mode).toBe('move');
      // Naming travels through the incumbent row, never the payload.
      expect(payload).not.toHaveProperty('authorName');
      expect(payload).not.toHaveProperty('narrators');
      expect(payload).not.toHaveProperty('metadata');
      expect(payload).not.toHaveProperty('narratorSource');
    });

    it('transitions the incumbent to importing inside the accepting transaction (AC6)', async () => {
      const incId = await seedIncumbent({ status: 'missing' });
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'missing' });
      await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      const [row] = await db.select().from(books).where(eq(books.id, incId));
      expect(row!.status).toBe('importing');
    });

    it('emits no book_added event — the book already existed (AC5)', async () => {
      const incId = await seedIncumbent();
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      const added = eventCreate.mock.calls.filter((c) => (c[0] as { eventType?: string }).eventType === 'book_added');
      expect(added).toHaveLength(0);
    });

    it('nudges the import worker once the transaction has committed', async () => {
      const incId = await seedIncumbent();
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      expect(nudge).toHaveBeenCalled();
    });

    it('rolls back and skips when the status moved since classification (AC6 guard miss)', async () => {
      // Classification observed `wanted`; the row is now `downloading`, so the guard cannot land.
      const incId = await seedIncumbent({ status: 'downloading' });
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      const subId = await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-importing');
      expect(await db.select().from(importJobs)).toHaveLength(0);
      // No orphaned `importing` left behind by a half-committed transition.
      const [row] = await db.select().from(books).where(eq(books.id, incId));
      expect(row!.status).toBe('downloading');
      expect(nudge).not.toHaveBeenCalled();
    });

    it('skips on the enqueue precheck conflict and rolls the status back (AC8)', async () => {
      const incId = await seedIncumbent();
      await db.insert(importJobs).values({ bookId: incId, type: 'manual', status: 'pending', metadata: '{}' });
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      const subId = await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-importing');
      const [row] = await db.select().from(books).where(eq(books.id, incId));
      expect(row!.status).toBe('wanted');
      expect(await db.select().from(importJobs)).toHaveLength(1);
    });

    it('maps the RAW active-job unique violation to skipped/already-importing, not failed (AC8/AC26)', async () => {
      const incId = await seedIncumbent();
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      const bis = new BookImportService(db, inject(log));
      // A competing pass claims the book between our precheck and our insert. Supplying a
      // transaction routes past the wrapper that would map this, so the raw violation escapes.
      vi.spyOn(bis, 'enqueue').mockImplementationOnce(async (input, tx) => {
        await tx!.insert(importJobs).values({ bookId: input.bookId, type: 'manual', status: 'pending', metadata: '{}' });
        await tx!.insert(importJobs).values({ bookId: input.bookId, type: 'manual', status: 'pending', metadata: input.metadata });
        return { jobId: -1 };
      });
      const subId = await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs, bis));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-importing');
      const [row] = await db.select().from(books).where(eq(books.id, incId));
      expect(row!.status).toBe('wanted');
    });

    it('does NOT swallow an unrelated unique violation — it still lands failed (AC26 negative)', async () => {
      const incId = await seedIncumbent();
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: null, status: 'wanted' });
      const bis = new BookImportService(db, inject(log));
      vi.spyOn(bis, 'enqueue').mockImplementationOnce(async (_input, tx) => {
        // books.public_id, not the active-job index: an over-broad catch would mislabel this.
        await tx!.insert(books).values({ publicId: 'clash-dup', title: 'X', status: 'wanted' });
        await tx!.insert(books).values({ publicId: 'clash-dup', title: 'Y', status: 'wanted' });
        return { jobId: -1 };
      });
      const subId = await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs, bis));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('failed');
      expect(item!.reason).not.toBe('already-importing');
      const [row] = await db.select().from(books).where(eq(books.id, incId));
      expect(row!.status).toBe('wanted');
    });

    it('still skips a file-holding incumbent as already-in-library (AC9 regression)', async () => {
      const incId = await seedIncumbent({ status: 'imported', path: '/library/Incumbent' });
      const bs = bookServiceReturning({ id: incId, title: 'Incumbent', path: '/library/Incumbent', status: 'imported' });
      const subId = await seedProcessing([stagedItem()], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('skipped');
      expect(item!.reason).toBe('already-in-library');
      expect(item!.existingBookId).toBe(incId);
      expect(await db.select().from(importJobs)).toHaveLength(0);
    });

    it('counts an attach as accepted in the completion aggregates (AC5)', async () => {
      const attachId = await seedIncumbent({ title: 'Attachable' });
      const ownedId = await seedIncumbent({ title: 'Owned', status: 'imported', path: '/library/Owned' });
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'findDuplicate')
        .mockResolvedValueOnce({ verdict: 'same-recording', book: { id: attachId, title: 'Attachable', path: null, status: 'wanted' } as never, hasIncumbent: true })
        .mockResolvedValueOnce({ verdict: 'same-recording', book: { id: ownedId, title: 'Owned', path: '/library/Owned', status: 'imported' } as never, hasIncumbent: true })
        .mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false } as never);
      const subId = await seedProcessing([
        { path: '/staging/A', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } },
        { path: '/staging/B', title: 'B', metadata: { title: 'B', authors: [{ name: 'X' }] } },
        { path: '/staging/C', title: 'C', metadata: { title: 'C', authors: [{ name: 'X' }] } },
      ], { source: 'manual', mode: 'copy' });

      await drainRunner(makeRunner(bs));

      const [header] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(header!.status).toBe('complete');
      // The attach counts as accepted, so the outcome toast reports no false skip.
      expect(header!.acceptedCount).toBe(2);
      expect(header!.skippedCount).toBe(1);
    });
  });

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
      expect(await db.select().from(books)).toHaveLength(1);
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

    // AC10: classifyConfirmItem grows no try/catch, so a throwing decision must reach the item
    // boundary and land a terminal failed row — the same disposition a throw produces today.
    it('a throwing duplicate decision → failed with the log-pointing reason; no book/job (#2235)', async () => {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'findDuplicate').mockRejectedValue(new Error('DB connection lost'));
      const subId = await seedProcessing([{ path: '/a', title: 'A', metadata: { title: 'A', authors: [{ name: 'X' }] } }]);

      await drainRunner(makeRunner(bs));

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('failed');
      expect(item!.reason).toBe('Import failed — see server logs for details.');
      expect(await db.select().from(books)).toHaveLength(0);
      expect(await db.select().from(importJobs)).toHaveLength(0);
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
      // SQLite does not enforce the JSON type, allowing this structurally invalid persisted blob.
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

  describe('accepted-item crash atomicity, side effects & provider ordering (F35/F39/F40)', () => {
    // Suppressing writeTerminal models process death, leaving the rolled-back item pending for boot recovery.
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
        await originalEnqueue(input, tx);
        throw new Error('crash after enqueue');
      });
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      await crashOnce(makeRunner(bs, bis));

      expect(await db.select().from(books)).toHaveLength(0);
      expect(await db.select().from(importJobs)).toHaveLength(0);
      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('pending');

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
      // maybeComplete runs inside the item transaction immediately after the disposition CAS.
      vi.spyOn(runner as unknown as { maybeComplete: (...a: unknown[]) => Promise<void> }, 'maybeComplete').mockRejectedValueOnce(new Error('crash after disposition'));
      const subId = await seedProcessing([acceptedItem('/a', 'A')]);

      await crashOnce(runner);

      expect(await db.select().from(books)).toHaveLength(0);
      expect(await db.select().from(importJobs)).toHaveLength(0);
      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('pending');

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
      expect(nudge).toHaveBeenCalled();
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
      // providerId without asin forces provider I/O.
      const item: StagedImportItem = { path: '/a', title: 'A', forceImport: true, metadata: { title: 'A', authors: [{ name: 'X' }], providerId: 'prov-1' } };
      const subId = await seedProcessing([item]);

      const drainP = drainRunner(runner);
      await waitFor(() => (metadataService.getBook as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      expect(txSpy).not.toHaveBeenCalled();

      releaseProvider({ asin: 'B0PROV1' });
      await drainP;

      expect(txSpy).toHaveBeenCalled();
      const [row] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(row!.disposition).toBe('accepted');
      txSpy.mockRestore();
    });

    it('persists manual copy AND move mode through the FULL createSubmission→PUT→finalize→runner flow; library omits it (F48)', async () => {
      const staging = new ImportStagingService(db, inject(log), () => { /* manually drained */ });

      async function runFlow(source: 'library' | 'manual', mode: 'copy' | 'move' | undefined, path: string): Promise<void> {
        const item = acceptedItem(path, path);
        const clientSubmissionId = randomUUID();
        const digest = createHash('sha256')
          .update(serializeSubmissionForDigest({ source, ...(mode ? { mode } : {}), items: [item] }))
          .digest('hex');
        await staging.createSubmission({ source, ...(mode ? { mode } : {}), clientSubmissionId, payloadDigest: digest, expectedCount: 1 } as never);
        const [hdr] = await db.select().from(importSubmissions).where(eq(importSubmissions.clientSubmissionId, clientSubmissionId));
        await staging.putItems(hdr!.id, { items: [{ ordinal: 0, item }] });
        await staging.finalize(hdr!.id);
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
      expect('mode' in JSON.parse(jobFor('/lib48')!.metadata as string)).toBe(false);
    });

    it('a post-commit book lookup failure does not suppress the worker nudge; item stays accepted and processing continues (F49)', async () => {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'getById').mockRejectedValueOnce(new Error('book lookup boom'));
      (log.warn as ReturnType<typeof vi.fn>).mockClear();
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B')]);

      await drainRunner(makeRunner(bs));

      const rows = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
      expect(rows[0]!.disposition).toBe('accepted');
      expect(rows[1]!.disposition).toBe('accepted');
      expect(nudge).toHaveBeenCalledTimes(2);
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
      expect(nudge).toHaveBeenCalledTimes(1);

      nudge.mockClear();
      await seedProcessing([acceptedItem('/b', 'B'), acceptedItem('/c', 'C'), acceptedItem('/d', 'D')]);
      await drainRunner(makeRunner(new BookService(db, inject(log))));
      expect(nudge).toHaveBeenCalledTimes(3);
    });

    it('serializes telemetry and event failures into diagnostic logs (F45)', async () => {
      const bs = new BookService(db, inject(log));
      vi.spyOn(bs, 'trackUnmatchedGenres').mockRejectedValue(new Error('telemetry boom'));
      eventCreate.mockRejectedValue(new Error('event boom'));
      (log.debug as ReturnType<typeof vi.fn>).mockClear();
      (log.warn as ReturnType<typeof vi.fn>).mockClear();
      await seedProcessing([acceptedItem('/a', 'A')]);

      await drainRunner(makeRunner(bs));

      await waitFor(() => (log.debug as ReturnType<typeof vi.fn>).mock.calls.length > 0 && (log.warn as ReturnType<typeof vi.fn>).mock.calls.length > 0);
      expect(log.debug as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'telemetry boom' }) }),
        expect.stringContaining('genres'),
      );
      expect(log.warn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'event boom' }) }),
        expect.stringContaining('book_added'),
      );
      expect((await db.select().from(books))).toHaveLength(1);
    });
  });

  describe('completion notification (#1894)', () => {
    it('dispatches import_run_finished exactly once with source + terminal counts on completion', async () => {
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
      await drainAll();
      expect(notifyStub).not.toHaveBeenCalled();
    });

    // Seeds terminal items under a processing header to exercise boot completion.
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
      // A separate connection observes only committed state, proving dispatch follows transaction resolution.
      const observer = createDb(dbFile);
      let statusSeenBySeparateConn: string | undefined;
      notifyStub.mockImplementation(async () => {
        const [h] = await observer.select().from(importSubmissions).where(eq(importSubmissions.id, subId)).limit(1);
        statusSeenBySeparateConn = h?.status;
      });
      await drainAll();
      expect(notifyStub).toHaveBeenCalledTimes(1);
      expect(statusSeenBySeparateConn).toBe('complete');
      observer.$client.close();
    });

    it('a rejected notifier dispatch leaves the header complete and does not stall later submissions (F14)', async () => {
      const first = await seedProcessing([null], { source: 'library' });
      const second = await seedProcessing([null], { source: 'manual', mode: 'copy' });
      notifyStub.mockRejectedValueOnce(new Error('notify lookup boom'));
      await drainAll();
      const [h1] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, first));
      const [h2] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, second));
      expect(h1!.status).toBe('complete');
      expect(h2!.status).toBe('complete');
      expect(notifyStub).toHaveBeenCalledTimes(2);
    });
  });

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

      expect(await db.select().from(books)).toHaveLength(2);
      expect(await db.select().from(importJobs)).toHaveLength(2);
    });

    it('two runners over SEPARATE connections process each ordinal at most once (CAS ≤1 per ordinal)', async () => {
      const subId = await seedProcessing([acceptedItem('/a', 'A'), acceptedItem('/b', 'B'), acceptedItem('/c', 'C')]);
      const db2 = createDb(dbFile);
      const r1 = makeRunner(new BookService(db, inject(log)));
      const r2 = makeRunnerWithDb(db2);
      r1.start();
      r2.start();
      // Re-nudge through transient lock losses; the disposition CAS still permits one winner per ordinal.
      await waitFor(async () => {
        r1.nudge();
        r2.nudge();
        return isComplete(subId)();
      }, 10_000);
      await Promise.all([r1.stop(), r2.stop()]);
      db2.$client.close();

      const items = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId)).orderBy(asc(importSubmissionItems.ordinal));
      expect(items.every((i) => i.disposition !== 'pending')).toBe(true);
      const acceptedCount = items.filter((i) => i.disposition === 'accepted').length;
      // Losing CAS writers roll back their placeholders, so books/jobs cannot exceed accepted items.
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
      await waitFor(() => (bs.resolveCreateInput as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);

      const stopP = r.stop();
      release();
      await stopP;

      const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
      expect(item!.disposition).toBe('accepted');
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.status).toBe('complete');
    });

    it('recovers on the next safety poll after a drain-level failure, without a restart (F19)', async () => {
      vi.useFakeTimers();
      try {
        const subId = await seedProcessing([acceptedItem('/a', 'A')]);
        const r = makeRunner(new BookService(db, inject(log)));
        // A one-shot submission SELECT failure must leave the item pending and reset the drain guards.
        const selectSpy = vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('transient drain blip'); });
        r.start();
        await vi.advanceTimersByTimeAsync(50);

        expect(selectSpy).toHaveBeenCalled();
        const [afterFail] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
        expect(afterFail!.disposition).toBe('pending');
        const [hdrFail] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
        expect(hdrFail!.status).toBe('processing');

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

  // The direct drain seam isolates database fencing from lifecycle timing.
  describe('forced-import staged dispositions (AC2/AC3, #1921)', () => {
    function forcedItem(path: string, title: string, asin?: string): StagedImportItem {
      return { path, title, forceImport: true, metadata: { title, authors: [{ name: 'Author' }], ...(asin ? { asin } : {}) } };
    }

    it('two forced re-confirms resolving to the SAME non-null ASIN → exactly [accepted, skipped(already-in-library)]; one book+job, both headers complete, no drop (AC2)', async () => {
      // With no incumbent seeded, the create-time ASIN index—not classification—chooses the winner.
      const subA = await seedProcessing([forcedItem('/tabA', 'Shared Book', 'B0SHARED1')]);
      const subB = await seedProcessing([forcedItem('/tabB', 'Shared Book', 'B0SHARED1')]);

      await drainAll();

      expect(await db.select().from(books)).toHaveLength(1);
      const jobs = await db.select().from(importJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.type).toBe('manual');

      const rows = await db.select().from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, subA))
        .then(async (a) => [...a, ...await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subB))]);
      expect(rows.every((r) => r.disposition !== 'pending')).toBe(true);
      expect(rows.map((r) => r.disposition).sort()).toEqual(['accepted', 'skipped']);
      const accepted = rows.find((r) => r.disposition === 'accepted')!;
      const skipped = rows.find((r) => r.disposition === 'skipped')!;
      expect(skipped.reason).toBe('already-in-library');
      expect(skipped.existingBookId).toBe(accepted.bookId);

      const [hA] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subA));
      const [hB] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subB));
      expect(hA!.status).toBe('complete');
      expect(hB!.status).toBe('complete');
    });

    it('two fresh forced null-ASIN submissions of the same book → both accepted, two books, two pending manual jobs (AC3 null-ASIN fence-gap pin)', async () => {
      // Null ASINs bypass the partial index and forceImport bypasses classification, so both submissions create books/jobs.
      const subA = await seedProcessing([forcedItem('/dup', 'Dup Book')]);
      const subB = await seedProcessing([forcedItem('/dup', 'Dup Book')]);

      await drainAll();

      const bookRows = await db.select().from(books);
      expect(bookRows).toHaveLength(2);
      expect(bookRows.every((b) => b.asin == null)).toBe(true);
      const jobs = await db.select().from(importJobs);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.status === 'pending' && j.type === 'manual')).toBe(true);

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

  // Non-forced siblings commit in ordinal order, exercising the confirm ladder against the first placeholder (#1925).
  describe('within-scan sibling confirm-ladder outcomes (#1925 AC6/AC7)', () => {
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
      expect(rows[1]!.existingBookId).toBe(rows[0]!.bookId);
      expect(rows[1]!.existingTitle).toBe('Harry Potter');
      expect(await db.select().from(books)).toHaveLength(1);
    });

    it('AC6 no usable identity signal (title+author only, no narrator/ASIN): first imports, second → review held; ONE book, ONE held', async () => {
      const subId = await seedProcessing([
        ladderItem('/hp/a', 'Harry Potter', { narrators: ['Jim Dale'] }),
        ladderItem('/hp/b', 'Harry Potter'),
      ]);

      await drainAll();

      const rows = await orderedItems(subId);
      expect(rows[0]!.disposition).toBe('accepted');
      expect(rows[1]!.disposition).toBe('held');
      expect(rows[1]!.reason).toBe('recording-review-required');
      expect(await db.select().from(books)).toHaveLength(1);
      const [h] = await db.select().from(importSubmissions).where(eq(importSubmissions.id, subId));
      expect(h!.acceptedCount).toBe(1);
      expect(h!.heldCount).toBe(1);
    });

    it('AC7 distinct editions (single narrator vs NAMED full-cast, unequal ASINs): both import; TWO books', async () => {
      const subId = await seedProcessing([
        ladderItem('/hp/a', 'Harry Potter', { narrators: ['Jim Dale'], asin: 'B0JIMDALE' }),
        // Named cast members must be used; an ALL-placeholder credit ("Full Cast" alone) has no survivor
        // set and reviews instead of separating the editions (#2206).
        ladderItem('/hp/b', 'Harry Potter', { narrators: ['Hugh Laurie', 'Cush Jumbo'], asin: 'B0FULLCAST' }),
      ]);

      await drainAll();

      const rows = await orderedItems(subId);
      expect(rows.every((r) => r.disposition === 'accepted')).toBe(true);
      expect(await db.select().from(books)).toHaveLength(2);
    });

    it('AC7 negative control (Tehanu shape — different ASIN, EQUAL narrator): second → same-recording skip; ONE book', async () => {
      // Unequal ASINs defer to narrator identity; matching narrator and duration resolve as the same recording.
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

  // Runner coverage reads source-folder OPF data before classification; adapter coverage lives in import-opf-ladder.integration.test.ts.
  describe('metadata.opf overlay (#2158)', () => {
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

    it('AC10/#2296 row 3: an OPF title/series never overrides a series the FOLDER genuinely asserted', async () => {
      const path = bookFolder('ac10-folder', opfWith([
        '<dc:title>Opf Title</dc:title>',
        '<meta name="calibre:series" content="Opf Series"/>',
        '<meta name="calibre:series_index" content="9"/>',
      ]));
      // Provider metadata carrying a THIRD series is what separates row 3 from row 4; without it this
      // case only proves row 2 (nothing to mirror) and passes even with the mirror rule inverted.
      await seedProcessing([{
        path, title: 'Folder Title', seriesName: 'Folder Series', seriesPosition: 2, forceImport: true,
        metadata: { title: 'T', authors: [{ name: 'A' }], seriesPrimary: { name: 'Provider Series', position: 5 } },
      }]);

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

      // Zero is a valid series position and must not be dropped as falsy.
      expect(await onlyBook()).toMatchObject({ seriesName: 'Opf Series', seriesPosition: 0 });
    });

    it('AC10 headline: TWO OPF aut creators against a single folder author keep the FOLDER author', async () => {
      // Two OPF creators force the metadata.authors branch; one provider author keeps the overlay on its constrained path.
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

    it('#2296 row 1: an OPF series OVERRIDES a series the PROVIDER supplied', async () => {
      const path = bookFolder('ac10-provider-series', opfWith([
        '<meta name="calibre:series" content="Opf Series"/>',
        '<meta name="calibre:series_index" content="9"/>',
      ]));
      await seedProcessing([{
        path, title: 'T', forceImport: true,
        metadata: { title: 'T', authors: [{ name: 'A' }], seriesPrimary: { name: 'Provider Series', position: 5 } },
      }]);

      await drainAll();

      expect(await onlyBook()).toMatchObject({ seriesName: 'Opf Series', seriesPosition: 9 });
    });

    // The client copies the provider's series into the top-level item of every untouched row, where it
    // outranks metadata.seriesPrimary at resolveImportSeries — so only this shape reproduces #2296.
    describe('#2296 — the client-shaped payload', () => {
      const OPF_SERIES = ['<meta name="calibre:series" content="Discworld"/>', '<meta name="calibre:series_index" content="4"/>'];

      function mirroredItem(path: string, extra: Partial<StagedImportItem> = {}): StagedImportItem {
        return {
          path, title: 'Mort', forceImport: true,
          seriesName: 'Discworld: Death', seriesPosition: 1,
          metadata: { title: 'Mort', authors: [{ name: 'Terry Pratchett' }], seriesPrimary: { name: 'Discworld: Death', position: 1 } },
          ...extra,
        };
      }

      it('row 4 headline: a provider-mirrored top-level pair is replaced by the OPF pair', async () => {
        const path = bookFolder('r4-headline', opfWith(OPF_SERIES));
        const subId = await seedProcessing([mirroredItem(path)]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({ seriesName: 'Discworld', seriesPosition: 4 });
        // Series is not an input to classifyConfirmItem, so rewriting it must not change the verdict.
        const [row] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, subId));
        expect(row!.disposition).toBe('accepted');
        // The adapter renders the library path from the enqueued payload, not from the row.
        expect(await jobPayload()).toMatchObject({ seriesName: 'Discworld', seriesPosition: 4 });
      });

      it('row 5: the hybrid pair (provider name + FOLDER position) is a mirror, and the stale position goes', async () => {
        const path = bookFolder('r5-hybrid', opfWith(OPF_SERIES));
        await seedProcessing([mirroredItem(path, {
          seriesPosition: 2,
          metadata: { title: 'Mort', authors: [{ name: 'Terry Pratchett' }], seriesPrimary: { name: 'Discworld: Death' } },
        })]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({ seriesName: 'Discworld', seriesPosition: 4 });
      });

      it('row 2b: metadata present with NO primary leaves nothing to mirror, so the item pair survives', async () => {
        const path = bookFolder('r2b-noprimary', opfWith(OPF_SERIES));
        await seedProcessing([{
          path, title: 'Mort', forceImport: true, seriesName: 'Folder Series', seriesPosition: 2,
          metadata: { title: 'Mort', authors: [{ name: 'A' }] },
        }]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({ seriesName: 'Folder Series', seriesPosition: 2 });
      });

      it('row 6: an OPF with no series leaves the mirrored item pair exactly as it arrived', async () => {
        const path = bookFolder('r6-noseries', opfWith(['<dc:description>Opf Description</dc:description>']));
        await seedProcessing([mirroredItem(path)]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({
          seriesName: 'Discworld: Death', seriesPosition: 1, description: 'Opf Description',
        });
      });

      it('AC10: a whitespace-only calibre:series destroys neither the provider nor the item pair', async () => {
        const path = bookFolder('r6-blank', opfWith([
          '<meta name="calibre:series" content="   "/>',
          '<meta name="calibre:series_index" content="4"/>',
        ]));
        await seedProcessing([mirroredItem(path)]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({ seriesName: 'Discworld: Death', seriesPosition: 1 });
      });

      it.each([
        ['an absent index', ['<meta name="calibre:series" content="Discworld"/>']],
        ['a non-numeric index', ['<meta name="calibre:series" content="Discworld"/>', '<meta name="calibre:series_index" content="abc"/>']],
      ])('%s yields a named series with NO position — the provider position is never inherited', async (_label, inner) => {
        const path = bookFolder(`r4-${_label.replace(/\s+/g, '-')}`, opfWith(inner));
        await seedProcessing([mirroredItem(path)]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({ seriesName: 'Discworld', seriesPosition: null });
        expect(await jobPayload()).not.toHaveProperty('seriesPosition');
      });

      it.each([
        ['zero', '0', 0],
        ['a decimal', '3.5', 3.5],
      ])('%s is a valid OPF position and replaces the mirrored one', async (_label, raw, expected) => {
        const path = bookFolder(`r4-pos-${raw}`, opfWith([
          '<meta name="calibre:series" content="Discworld"/>',
          `<meta name="calibre:series_index" content="${raw}"/>`,
        ]));
        await seedProcessing([mirroredItem(path)]);

        await drainAll();

        expect(await onlyBook()).toMatchObject({ seriesName: 'Discworld', seriesPosition: expected });
      });

      it('two books whose OPFs assert the SAME series and position both import, neither renumbered', async () => {
        const inner = ['<meta name="calibre:series" content="The Cosmere"/>', '<meta name="calibre:series_index" content="2"/>'];
        await seedProcessing([
          mirroredItem(bookFolder('collide-a', opfWith(inner)), { title: 'Mistborn' }),
          mirroredItem(bookFolder('collide-b', opfWith(inner)), { title: 'Stormlight' }),
        ]);

        await drainAll();

        const rows = await db.select().from(books).orderBy(asc(books.id));
        expect(rows.map((r) => [r.seriesName, r.seriesPosition])).toEqual([['The Cosmere', 2], ['The Cosmere', 2]]);
        const members = await db.select().from(seriesMembers);
        expect(members.map((m) => m.position)).toEqual([2, 2]);
      });
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

    describe('AC11 — identity', () => {
      const OPF_ASIN = opfWith(['<dc:identifier opf:scheme="ASIN">B0OPFASIN1</dc:identifier>']);

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

    it('D1: OPF narrators are visible to classifyConfirmItem', async () => {
      const path = bookFolder('d1-order', opfWith(['<dc:creator opf:role="nrt">Opf Narrator</dc:creator>']));
      const bs = new BookService(db, inject(log));
      const spy = vi.spyOn(bs, 'findDuplicate').mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false } as never);
      await seedProcessing([{ path, title: 'T' }]);

      await drainRunner(makeRunner(bs));

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

    it('D2: a manual COPY submission reads the OPF at the SOURCE folder', async () => {
      // Manual staging copies audio only (#1602), so the OPF must be read from source rather than finalPath.
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
      // Coalesced groups point at a member folder, so a parent sidecar remains deliberately out of scope.
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

      // Check storage and adapter re-parse so schema stripping is caught at its boundary.
      const payload = await jobPayload();
      expect(payload).toMatchObject({ narratorSource: expected });
      expect(manualImportJobPayloadSchema.parse(payload).narratorSource).toBe(expected);
    });
  });
});
