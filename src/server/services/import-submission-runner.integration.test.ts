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
  let db: Db;
  let runner: ImportSubmissionRunner;
  let nudge: ReturnType<typeof vi.fn>;
  let eventCreate: ReturnType<typeof vi.fn>;
  const log = createMockLogger();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'runner-'));
    const dbFile = join(dir, 'narratorr.db');
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

  async function drainAll(): Promise<void> {
    // drainOne runs inside a running runner; flip `running` to exercise it directly
    // (the F72 pre-claim barrier aborts otherwise).
    (runner as unknown as { running: boolean }).running = true;
    const seam = runner as unknown as DrainSeam;
    let guard = 0;
    while (await seam.drainOne()) {
      if (++guard > 1000) throw new Error('drain did not converge');
    }
  }

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
});
