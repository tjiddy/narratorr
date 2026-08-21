import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { importListExclusions, importLists, settingsMigrations } from '@db/schema.js';
import { BookService } from './book.service.js';
import { ImportListExclusionService } from './import-list-exclusion.service.js';
import { ADD_LEDGER_BACKFILL_ID, backfillImportListAddLedger } from './import-list-add-ledger-backfill.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

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
    // The marker insert is the transaction's LAST statement, so hiding its table makes the failure
    // land after every ledger row was already issued — the only stimulus that reaches rollback
    // after issuance rather than before it.
    await db.run(sql`ALTER TABLE settings_migrations RENAME TO settings_migrations_hidden`);

    await run();

    expect(await ledger()).toHaveLength(0);

    await db.run(sql`ALTER TABLE settings_migrations_hidden RENAME TO settings_migrations`);
    expect(await marker()).toBe(false);

    // And the retry seeds everything, so the rollback cost nothing but a boot.
    await run();
    expect((await ledger()).map((r) => r.title)).toEqual(['The Reckoning']);
    expect(await marker()).toBe(true);
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
    // 130 > the 120-row chunk size, so the loop runs twice and the chunking is exercised rather
    // than assumed. Inserted directly: 130 `bookService.create` calls would dominate the suite.
    const COUNT = 130;
    for (let i = 0; i < COUNT; i++) {
      await db.run(sql`
        INSERT INTO books (public_id, title, import_list_id) VALUES (${`bk_${i}`}, ${`Book ${i}`}, ${listId})
      `);
    }

    await run();

    expect(await ledger()).toHaveLength(COUNT);
  });

  it('opens exactly one transaction, so it cannot nest inside another', async () => {
    await seedBook({ title: 'The Reckoning' });
    const txSpy = vi.spyOn(db, 'transaction');

    await run();

    expect(txSpy).toHaveBeenCalledTimes(1);
  });
});
