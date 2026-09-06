import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importListExclusions, importLists, settingsMigrations } from '@db/schema.js';
import { BookService } from './book.service.js';
import { ImportListExclusionService } from './import-list-exclusion.service.js';
import { ADD_LEDGER_BACKFILL_ID, ROWS_PER_INSERT, backfillImportListAddLedger } from './import-list-add-ledger-backfill.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { spyStatements, type CapturedStatement } from '../__tests__/statement-spy.js';

// A real migrated database throughout: the marker's idempotence, the transaction's atomicity and
// the empty-slug round trip are all invisible to a mocked db.

describe('backfillImportListAddLedger (DB-backed, #2530)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let exclusions: ImportListExclusionService;
  let listId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'add-ledger-backfill-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);
    bookService = new BookService(db, logger);
    exclusions = new ImportListExclusionService(db, logger);

    const [list] = await db.insert(importLists).values({ name: 'NYT Bestsellers', type: 'nyt', settings: {} }).returning();
    listId = list!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  async function seedBook(opts: {
    title: string;
    author?: string | null;
    asin?: string;
    fromList?: boolean;
  }): Promise<number> {
    const book = await bookService.create({
      title: opts.title,
      authors: opts.author === null ? [] : [{ name: opts.author ?? 'Jane Doe' }],
      ...(opts.asin && { asin: opts.asin }),
      status: 'wanted',
      ...(opts.fromList !== false && { importListId: listId }),
    });
    return book.id;
  }

  const run = () => backfillImportListAddLedger(db, exclusions, inject<FastifyBaseLogger>(log));
  const ledger = () => db.select().from(importListExclusions);
  const marker = async () =>
    (await db.select().from(settingsMigrations).where(eq(settingsMigrations.id, ADD_LEDGER_BACKFILL_ID))).length > 0;

  /**
   * Seeds `count` list-sourced books and runs the backfill under one statement spy, so the same
   * capture covers the seed (client scope) and the backfill's chunk inserts (transaction scope).
   *
   * The seed is ONE multi-row insert, not a loop, and must stay that way. libsql statement
   * execution is synchronous, so 130 sequential single-row inserts cost ~150 ms each on the
   * disk-bound Windows runner: they carried this file's chunk-boundary case past the 15 s
   * `testTimeout` on two consecutive tag runs (20,618 ms and 15,769 ms, green on rerun both
   * times) while measuring 387 ms on Linux, against 50 ms batched. The books are scaffolding —
   * only the backfill's own chunk loop is under test (#2601). Still not `bookService.create`, for
   * the original reason: 130 of those would dominate the suite.
   */
  async function seedListBooksAndRun(count: number): Promise<{
    seedInserts: CapturedStatement[];
    chunkInserts: CapturedStatement[];
  }> {
    const spy = spyStatements(db);
    try {
      await db.insert(books).values(
        Array.from({ length: count }, (_, i) => ({ publicId: `bk_${i}`, title: `Book ${i}`, importListId: listId })),
      );
      await run();
    } finally {
      // Patched by instance assignment, so `vi.restoreAllMocks()` does not undo it; left armed it
      // would also capture the assertions' own reads.
      spy.restore();
    }
    // Optional quoting on purpose: Drizzle quotes the table, a hand-written `sql` INSERT does not,
    // and a seed regressed back into a raw loop must be COUNTED by this filter rather than missed
    // by it — otherwise the count assertion reds on the spelling instead of on the statement count.
    return {
      seedInserts: spy.executed.filter((s) => s.scope === 'client' && /insert into "?books"?[\s(]/i.test(s.sql)),
      chunkInserts: spy.executed.filter(
        (s) => s.scope !== 'client' && /insert into "?import_list_exclusions"?[\s(]/i.test(s.sql),
      ),
    };
  }

  it('seeds one added row per list-sourced book, carrying its identity and provenance', async () => {
    await seedBook({ title: 'The Reckoning', author: 'Jane Doe', asin: ' b0abc12345 ' });

    await run();

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'The Reckoning',
      asin: 'B0ABC12345',
      authorName: 'Jane Doe',
      authorSlug: 'jane-doe',
      importListId: listId,
      importListName: 'NYT Bestsellers',
      kind: 'added',
    });
  });

  it('skips a manually added book', async () => {
    await seedBook({ title: 'Hand Added', fromList: false });
    await seedBook({ title: 'From The List' });

    await run();

    expect((await ledger()).map((r) => r.title)).toEqual(['From The List']);
  });

  it('skips a book whose list was deleted first and nulled the provenance', async () => {
    await seedBook({ title: 'Orphaned' });
    await db.delete(importLists).where(eq(importLists.id, listId));

    await run();

    expect(await ledger()).toHaveLength(0);
    // Still a success: the accepted consequence the deletion path already documents.
    expect(await marker()).toBe(true);
  });

  it('seeds an authorless book with both author columns null, and finds it again', async () => {
    await seedBook({ title: 'A Nameless Source', author: null });

    await run();

    const [row] = await ledger();
    expect(row!.authorName).toBeNull();
    expect(row!.authorSlug).toBeNull();
    expect((await exclusions.isExcluded({ title: 'A Nameless Source' }))?.id).toBe(row!.id);
  });

  it('stores NULL, not an empty string, for an author name that slugs to nothing', async () => {
    // Routed through `buildExclusionValues`, so this also pins that the backfill grew no private
    // value-construction path of its own (#2321's round trip).
    await seedBook({ title: 'The Reckoning', author: ' ?? ' });

    await run();

    const [row] = await ledger();
    expect(row!.authorSlug).toBeNull();
    expect(await exclusions.isExcluded({ title: 'The Reckoning', authorName: '!!!' })).not.toBeNull();
  });

  it('runs exactly once, and does not resurrect a row the operator removed', async () => {
    await seedBook({ title: 'The Reckoning' });
    await run();
    const [seeded] = await ledger();

    await exclusions.delete(seeded!.id);
    await run();

    expect(await ledger()).toHaveLength(0);
  });

  it('inserts nothing on a second call even with new list-sourced books present', async () => {
    await seedBook({ title: 'First' });
    await run();

    await seedBook({ title: 'Second' });
    await run();

    expect((await ledger()).map((r) => r.title)).toEqual(['First']);
  });

  it('commits neither the ledger rows nor the marker when the run fails partway', async () => {
    await seedBook({ title: 'The Reckoning' });
    // Reject the marker INSERT while leaving the marker read working, so the failure lands after
    // every ledger row was already issued — the only stimulus that reaches rollback after issuance
    // rather than before it. Hiding the whole table would fail the guard read first and leave
    // nothing issued to roll back, which is a vacuous version of this case.
    await db.run(sql`
      CREATE TRIGGER reject_backfill_marker BEFORE INSERT ON settings_migrations
      BEGIN SELECT RAISE(ABORT, 'settings_migrations locked'); END
    `);

    await run();

    expect(await ledger()).toHaveLength(0);
    expect(await marker()).toBe(false);

    // And the retry seeds everything, so the rollback cost nothing but a boot.
    await db.run(sql`DROP TRIGGER reject_backfill_marker`);
    await run();
    expect((await ledger()).map((r) => r.title)).toEqual(['The Reckoning']);
    expect(await marker()).toBe(true);
  });

  it('seeds one ledger set, not two, when a second backfill overlaps the first (F1)', async () => {
    await seedBook({ title: 'The Reckoning' });
    await seedBook({ title: 'The Awakening', author: 'John Roe' });

    await Promise.all([run(), run()]);

    // With the marker read outside the transaction both calls observe it absent and each seeds a
    // full ledger, and `onConflictDoNothing` suppresses only the duplicate marker — the operator's
    // undo page then lists every book twice.
    expect((await ledger()).map((r) => r.title).sort()).toEqual(['The Awakening', 'The Reckoning']);
    expect(await marker()).toBe(true);

    // Exactly one of the two did the work; the loser short-circuited rather than failing.
    const seededLogs = (log.info as Mock).mock.calls.filter(
      (c: unknown[]) => c[1] === 'Seeded the import list add ledger from existing list-sourced books',
    );
    expect(seededLogs).toHaveLength(1);
    expect(seededLogs[0]![0]).toMatchObject({ seeded: 2 });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('leaves the marker unset when the ledger value boundary rejects a row', async () => {
    // The write-boundary guard's backfill arm: it propagates under this caller's existing rule —
    // swallowed and warned, marker unset — with no handling of its own.
    await seedBook({ title: 'The Reckoning' });
    vi.spyOn(exclusions, 'buildExclusionValues').mockImplementation(() => {
      throw new Error('Invalid enum value for kind');
    });

    await expect(run()).resolves.toBeUndefined();

    expect(await ledger()).toHaveLength(0);
    expect(await marker()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ migration: ADD_LEDGER_BACKFILL_ID }),
      'Import list add-ledger backfill failed — will retry on next boot',
    );
  });

  it('logs at warn, does not throw, and leaves the marker unset when the run fails', async () => {
    await seedBook({ title: 'The Reckoning' });
    vi.spyOn(db, 'transaction').mockRejectedValue(new Error('database is locked'));

    await expect(run()).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ migration: ADD_LEDGER_BACKFILL_ID }),
      'Import list add-ledger backfill failed — will retry on next boot',
    );
    expect(await marker()).toBe(false);
  });

  it('seeds everything on the retry after a failed run', async () => {
    await seedBook({ title: 'The Reckoning' });
    const failing = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('database is locked'));
    await run();
    failing.mockRestore();

    await run();

    expect((await ledger()).map((r) => r.title)).toEqual(['The Reckoning']);
    expect(await marker()).toBe(true);
  });

  it('is a no-op that still sets the marker when no book came from a list', async () => {
    await seedBook({ title: 'Hand Added', fromList: false });

    await run();

    expect(await ledger()).toHaveLength(0);
    expect(await marker()).toBe(true);
  });

  it('lands every row when the candidate count exceeds one insert chunk', async () => {
    const COUNT = 130;
    // Keyed to the real threshold rather than trusting two independent literals: if the chunk size
    // ever rises past COUNT the loop collapses to one chunk and this case stops covering chunking.
    expect(COUNT).toBeGreaterThan(ROWS_PER_INSERT);

    const { seedInserts, chunkInserts } = await seedListBooksAndRun(COUNT);

    expect(seedInserts).toHaveLength(1);
    expect(chunkInserts).toHaveLength(2);
    // A silently truncated batch would otherwise make the ledger length agree with a short seed.
    expect(
      await db.select({ title: books.title, importListId: books.importListId }).from(books).orderBy(books.id),
    ).toEqual(Array.from({ length: COUNT }, (_, i) => ({ title: `Book ${i}`, importListId: listId })));
    expect(await ledger()).toHaveLength(COUNT);
  });

  it('lands every row in one chunk insert when the candidate count is exactly the chunk size', async () => {
    // The negative half of the case above: it proves the 2-statement assertion measures chunk
    // count rather than reading back a constant.
    const { seedInserts, chunkInserts } = await seedListBooksAndRun(ROWS_PER_INSERT);

    expect(seedInserts).toHaveLength(1);
    expect(chunkInserts).toHaveLength(1);
    expect(await ledger()).toHaveLength(ROWS_PER_INSERT);
  });

  it('splits into a full chunk and a single-row chunk one candidate over the chunk size', async () => {
    const { seedInserts, chunkInserts } = await seedListBooksAndRun(ROWS_PER_INSERT + 1);

    expect(seedInserts).toHaveLength(1);
    expect(chunkInserts).toHaveLength(2);
    // Bound parameters divide evenly by row, so the trailing chunk's arg count IS its row count —
    // `chunkArray`'s slice arithmetic pinned at its tightest point.
    const perRow = (chunkInserts[0]!.args as unknown[]).length / ROWS_PER_INSERT;
    expect((chunkInserts[1]!.args as unknown[]).length).toBe(perRow);
    expect(await ledger()).toHaveLength(ROWS_PER_INSERT + 1);
  });

  it('opens exactly one transaction, so it cannot nest inside another', async () => {
    await seedBook({ title: 'The Reckoning' });
    const txSpy = vi.spyOn(db, 'transaction');

    await run();

    expect(txSpy).toHaveBeenCalledTimes(1);
  });
});
