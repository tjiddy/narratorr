import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, and, inArray } from 'drizzle-orm';
import { books, importJobs } from '@db/schema.js';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { BookImportService } from './book-import.service.js';

describe('BookImportService — enqueue (#747 integration with real libsql)', () => {
  let dir: string;
  let db: Db;
  let service: BookImportService;
  const log = createMockLogger();

  async function seedBook(overrides: { title?: string; status?: 'wanted' | 'importing' | 'failed' } = {}) {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: overrides.title ?? 'Seed', status: overrides.status ?? 'wanted' })
      .returning();
    return row;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'import-jobs-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new BookImportService(db, inject(log));
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may retain Windows handles; cleanup is best-effort.
    }
  });

  it('inserts a single auto job when no active row exists', async () => {
    const book = await seedBook();

    const result = await service.enqueue({
      bookId: book!.id,
      type: 'auto',
      metadata: JSON.stringify({ downloadId: 5 }),
    });

    expect(result).toEqual({ jobId: expect.any(Number) });
    const rows = await db.select().from(importJobs).where(eq(importJobs.bookId, book!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  it('returns active-job-exists when a pending row already exists for the bookId', async () => {
    const book = await seedBook();
    await db.insert(importJobs).values({
      bookId: book!.id, type: 'auto', status: 'pending', metadata: '{"downloadId":1}',
    });

    const result = await service.enqueue({
      bookId: book!.id,
      type: 'auto',
      metadata: JSON.stringify({ downloadId: 2 }),
    });

    expect(result).toEqual({ error: 'active-job-exists', status: 409 });
    const rows = await db.select().from(importJobs).where(eq(importJobs.bookId, book!.id));
    expect(rows).toHaveLength(1);
  });

  it('returns active-job-exists when a processing row already exists for the bookId', async () => {
    const book = await seedBook();
    await db.insert(importJobs).values({
      bookId: book!.id, type: 'manual', status: 'processing', metadata: '{}',
    });

    const result = await service.enqueue({ bookId: book!.id, type: 'manual', metadata: '{}' });

    expect(result).toEqual({ error: 'active-job-exists', status: 409 });
  });

  it('allows enqueue after a previous job completed (status=completed)', async () => {
    const book = await seedBook();
    await db.insert(importJobs).values({
      bookId: book!.id, type: 'auto', status: 'completed', metadata: '{}',
    });

    const result = await service.enqueue({ bookId: book!.id, type: 'auto', metadata: '{"downloadId":1}' });

    expect(result).toEqual({ jobId: expect.any(Number) });
  });

  it('allows enqueue after a previous job failed', async () => {
    const book = await seedBook();
    await db.insert(importJobs).values({
      bookId: book!.id, type: 'manual', status: 'failed', metadata: '{}',
    });

    const result = await service.enqueue({ bookId: book!.id, type: 'manual', metadata: '{}' });

    expect(result).toEqual({ jobId: expect.any(Number) });
  });

  it('partial unique index permits multiple active orphan rows (book_id IS NULL)', async () => {
    // Book deletion nulls active-job FKs; the partial unique index must allow multiple orphans.
    await db.insert(importJobs).values([
      { bookId: null, type: 'auto', status: 'pending', metadata: '{"downloadId":1}' },
      { bookId: null, type: 'auto', status: 'pending', metadata: '{"downloadId":2}' },
      { bookId: null, type: 'manual', status: 'processing', metadata: '{}' },
    ]);

    const orphans = await db
      .select()
      .from(importJobs)
      .where(and(inArray(importJobs.status, ['pending', 'processing']), eq(importJobs.bookId, null as unknown as number)));

    // SQL book_id = NULL matches nothing, so count orphans from the unfiltered rows.
    const allRows = await db.select().from(importJobs);
    const activeOrphans = allRows.filter((r) => r.bookId == null && (r.status === 'pending' || r.status === 'processing'));
    expect(activeOrphans).toHaveLength(3);
    expect(orphans).toHaveLength(0);
  });

  it('second retry-import call returns 409 once an active row already exists (sequential race-loser)', async () => {
    // One libsql connection serializes writes, so test the unique-index backstop with a sequential loser.
    const book = await seedBook({ status: 'failed' });
    await db.insert(importJobs).values({
      bookId: book!.id, type: 'manual', status: 'failed', metadata: '{"path":"/x"}',
    });

    const nudge = (): void => {};
    const r1 = await service.retryImport(book!.id, nudge);
    expect(r1).toMatchObject({ jobId: expect.any(Number) });

    // Reset status so the second call reaches enqueue and observes the index conflict.
    await db.update(books).set({ status: 'failed' }).where(eq(books.id, book!.id));

    const r2 = await service.retryImport(book!.id, nudge);
    expect(r2).toEqual({
      error: 'An import job for this book is already queued or running',
      code: 'active_job_exists',
      status: 409,
    });

    const activeRows = await db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.bookId, book!.id), inArray(importJobs.status, ['pending', 'processing'])));
    expect(activeRows).toHaveLength(1);
  });

  it('migration #747 dedupes existing active duplicates (keeps newest, marks losers failed) for non-null book_id', async () => {
    const book = await seedBook();
    // The migrated index prevents recreating a pre-migration duplicate fixture; seed one winner.
    const [first] = await db.insert(importJobs).values({
      bookId: book!.id, type: 'auto', status: 'pending', metadata: '{"downloadId":1}',
    }).returning();

    // libsql wraps the partial-index UNIQUE message under cause.
    const indexError = await db
      .insert(importJobs)
      .values({
        bookId: book!.id, type: 'auto', status: 'pending', metadata: '{"downloadId":2}',
      })
      .catch((e: unknown) => e);
    expect(indexError).toBeInstanceOf(Error);
    const cause = (indexError as Error & { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/UNIQUE constraint failed.*(?:idx_import_jobs_book_active|import_jobs\.book_id)/);

    const activeRows = await db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.bookId, book!.id), inArray(importJobs.status, ['pending', 'processing'])));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]!.id).toBe(first!.id);
  });

  it('rolls back the importJobs INSERT when the books UPDATE fails mid-tx (#799 AC1)', async () => {
    // Sabotage the books update inside the real transaction; insert, status, and nudge must roll back together.
    const book = await seedBook({ status: 'failed' });
    await db.insert(importJobs).values({
      bookId: book!.id, type: 'manual', status: 'failed', metadata: '{"path":"/x"}',
    });

    const sabotagedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (cb: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              const sabotagedTx = new Proxy(tx as object, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === 'update') {
                    return (table: unknown) => {
                      if (table === books) {
                        throw new Error('simulated books UPDATE failure');
                      }
                      // Forward non-target tables to the real transaction.
                      return (Reflect.get(txTarget, txProp, txReceiver) as
                        (t: unknown) => unknown)(table);
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return cb(sabotagedTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const sabotagedService = new BookImportService(sabotagedDb, inject(log));
    const nudge = vi.fn();

    await expect(sabotagedService.retryImport(book!.id, nudge)).rejects.toThrow(
      'simulated books UPDATE failure',
    );

    const activeRows = await db
      .select()
      .from(importJobs)
      .where(and(
        eq(importJobs.bookId, book!.id),
        inArray(importJobs.status, ['pending', 'processing']),
      ));
    expect(activeRows).toHaveLength(0);

    const [bookAfter] = await db.select().from(books).where(eq(books.id, book!.id));
    expect(bookAfter!.status).toBe('failed');

    expect(nudge).not.toHaveBeenCalled();
  });

  it('partial unique index does NOT reject rows with NULL book_id (orphan coexistence)', async () => {
    const a = await db.insert(importJobs).values({
      bookId: null, type: 'auto', status: 'pending', metadata: '{"downloadId":11}',
    }).returning();
    const b = await db.insert(importJobs).values({
      bookId: null, type: 'auto', status: 'pending', metadata: '{"downloadId":12}',
    }).returning();
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });
});
