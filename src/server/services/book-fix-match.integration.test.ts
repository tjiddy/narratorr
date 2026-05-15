import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import {
  books,
  bookAuthors,
  bookNarrators,
  authors,
  narrators,
  series,
  seriesMembers,
} from '../../db/schema.js';
import { BookService } from './book.service.js';
import { replaceSeriesLink } from './book-series-link.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

/**
 * Integration tests for `BookService.fixMatch` and `replaceSeriesLink` against
 * a real in-memory SQLite database. Covers the transactional persistence path
 * the route tests can't exercise (those mock `services.book.fixMatch`).
 *
 * AC mapping: F2 of PR #1130 review — direct service-level DB-mutation tests
 * for the new Fix Match transaction.
 */
describe('BookService.fixMatch — integration (#1129 F2)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fix-match-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows
    }
  });

  async function seedBookA(svc: BookService): Promise<number> {
    const created = await svc.create({
      title: 'Old Title',
      authors: [{ name: 'Old Author', asin: 'OLDAUTH' }],
      narrators: ['Old Narrator'],
      asin: 'B_OLD',
      seriesName: 'Old Series',
      seriesPosition: 1,
      seriesAsin: 'OLD_SERIES_ID',
      duration: 600,
      publishedDate: '2020-01-01',
      genres: ['Old Genre'],
    });
    // Simulate locally-populated state that Fix Match must preserve
    await db.update(books).set({
      path: '/library/old-path',
      size: 12345,
      audioCodec: 'aac',
      audioBitrate: 128,
      audioFileCount: 1,
      lastGrabGuid: 'guid:old',
      lastGrabInfoHash: 'hash:old',
      enrichmentStatus: 'enriched',
    }).where(eq(books.id, created.id));
    return created.id;
  }

  it('series-bearing rematch: replaces scalars, authors, narrators, series link; preserves local state; resets enrichmentStatus', async () => {
    const svc = new BookService(db, log);
    const bookId = await seedBookA(svc);

    const updated = await svc.fixMatch(bookId, {
      asin: 'B_NEW',
      title: 'New Title',
      authors: [{ name: 'New Author', asin: 'NEWAUTH' }],
      narrators: ['New Narrator'],
      description: 'New description',
      coverUrl: 'https://example.com/new.jpg',
      duration: 1200,
      publishedDate: '2024-05-01',
      seriesName: 'New Series',
      seriesPosition: 2,
      seriesAsin: 'NEW_SERIES_ID',
      genres: ['Fantasy'],
      isbn: '9781234567890',
      seriesProvider: 'audible',
    });
    expect(updated).not.toBeNull();

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.asin).toBe('B_NEW');
    expect(row!.title).toBe('New Title');
    expect(row!.description).toBe('New description');
    expect(row!.coverUrl).toBe('https://example.com/new.jpg');
    expect(row!.duration).toBe(1200);
    expect(row!.publishedDate).toBe('2024-05-01');
    expect(row!.seriesName).toBe('New Series');
    expect(row!.seriesPosition).toBe(2);
    expect(row!.isbn).toBe('9781234567890');
    expect(row!.genres).toEqual(['Fantasy']);
    expect(row!.enrichmentStatus).toBe('pending');
    // Preserved local state
    expect(row!.path).toBe('/library/old-path');
    expect(row!.size).toBe(12345);
    expect(row!.audioCodec).toBe('aac');
    expect(row!.audioBitrate).toBe(128);
    expect(row!.audioFileCount).toBe(1);
    expect(row!.lastGrabGuid).toBe('guid:old');
    expect(row!.lastGrabInfoHash).toBe('hash:old');

    // Author/narrator junctions reflect ONLY the new identity
    const authorRows = await db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(bookAuthors.bookId, bookId));
    expect(authorRows.map((r) => r.name)).toEqual(['New Author']);

    const narratorRows = await db
      .select({ name: narrators.name })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .where(eq(bookNarrators.bookId, bookId));
    expect(narratorRows.map((r) => r.name)).toEqual(['New Narrator']);

    // series_members points at the NEW series; old membership gone
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members).toHaveLength(1);
    const seriesRow = (await db.select().from(series).where(eq(series.id, members[0]!.seriesId)))[0]!;
    expect(seriesRow.providerSeriesId).toBe('NEW_SERIES_ID');
    expect(seriesRow.normalizedName).toBe('new series');
  });

  it('no-series rematch: nullifies seriesName/seriesPosition, clears series_members without inserting (F15)', async () => {
    const svc = new BookService(db, log);
    const bookId = await seedBookA(svc);

    // Pre-condition: an old series_members row exists for this book
    expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(1);

    const updated = await svc.fixMatch(bookId, {
      asin: 'B_STANDALONE',
      title: 'Standalone Title',
      authors: [{ name: 'Solo Author' }],
      narrators: ['Solo Narrator'],
      description: 'A standalone book',
      coverUrl: 'https://example.com/solo.jpg',
      duration: 500,
      publishedDate: '2024-05-02',
      // No seriesName / seriesPosition / seriesAsin
    });
    expect(updated).not.toBeNull();

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.seriesName).toBeNull();
    expect(row!.seriesPosition).toBeNull();
    expect(row!.asin).toBe('B_STANDALONE');

    // No membership rows remain for the book
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members).toHaveLength(0);
  });

  it('returns null when the book id does not exist', async () => {
    const svc = new BookService(db, log);
    const result = await svc.fixMatch(99999, {
      asin: 'B_NEW',
      title: 'New Title',
      authors: [{ name: 'A' }],
    });
    expect(result).toBeNull();
  });
});

describe('replaceSeriesLink — integration (#1129 F2)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'replace-series-link-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows
    }
  });

  async function insertBookRow(asin: string, title: string): Promise<number> {
    const [row] = await db.insert(books).values({ title, asin }).returning();
    return row!.id;
  }

  it('args=null: deletes all prior series_members rows for the book and inserts nothing', async () => {
    const bookId = await insertBookRow('B_NS', 'Standalone');
    const [seriesRow] = await db.insert(series).values({
      provider: 'audible',
      providerSeriesId: 'OLD_SID',
      name: 'Old Series',
      normalizedName: 'old series',
    }).returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      bookId,
      providerBookId: 'B_NS',
      title: 'Old Title',
      normalizedTitle: 'old title',
      authorName: 'Old Author',
      positionRaw: '1',
      position: 1,
    });

    await db.transaction(async (tx) => {
      await replaceSeriesLink(tx, bookId, null);
    });

    expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(0);
  });

  it('args=payload: deletes prior row(s) AND inserts exactly one new member', async () => {
    const bookId = await insertBookRow('B_RM', 'Rematched');
    const [oldSeries] = await db.insert(series).values({
      provider: 'audible',
      providerSeriesId: 'OLD_SID',
      name: 'Old Series',
      normalizedName: 'old series',
    }).returning();
    await db.insert(seriesMembers).values({
      seriesId: oldSeries!.id,
      bookId,
      providerBookId: 'B_RM',
      title: 'Old Title',
      normalizedTitle: 'old title',
      authorName: 'Old Author',
      positionRaw: '1',
      position: 1,
    });

    await db.transaction(async (tx) => {
      await replaceSeriesLink(tx, bookId, {
        name: 'New Series',
        position: 3,
        asin: 'B_RM',
        seriesAsin: 'NEW_SID',
        provider: 'audible',
        title: 'New Title',
        authorName: 'New Author',
      });
    });

    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members).toHaveLength(1);
    const linkedSeries = (await db.select().from(series).where(eq(series.id, members[0]!.seriesId)))[0]!;
    expect(linkedSeries.providerSeriesId).toBe('NEW_SID');
    expect(linkedSeries.name).toBe('New Series');
    expect(members[0]!.title).toBe('New Title');
    expect(members[0]!.authorName).toBe('New Author');
    expect(members[0]!.position).toBe(3);
  });

  it('reuses an existing series row when seriesAsin already matches a row', async () => {
    const bookId = await insertBookRow('B_REUSE', 'Reuse');
    const [seeded] = await db.insert(series).values({
      provider: 'audible',
      providerSeriesId: 'SEED_SID',
      name: 'Seed Series',
      normalizedName: 'seed series',
    }).returning();

    await db.transaction(async (tx) => {
      await replaceSeriesLink(tx, bookId, {
        name: 'Seed Series',
        position: 2,
        asin: 'B_REUSE',
        seriesAsin: 'SEED_SID',
        provider: 'audible',
        title: 'Reuse',
        authorName: 'A',
      });
    });

    const allSeries = await db.select().from(series);
    expect(allSeries).toHaveLength(1);
    expect(allSeries[0]!.id).toBe(seeded!.id);
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members[0]!.seriesId).toBe(seeded!.id);
  });

  it('errors propagate (transaction rolls back) when the new member insert fails', async () => {
    const svc = new BookService(db, log());
    const created = await svc.create({
      title: 'Pre-rematch Title',
      authors: [{ name: 'Pre Author' }],
      asin: 'B_PRE',
      seriesName: 'Pre Series',
      seriesPosition: 1,
    });

    // Capture the original membership BEFORE we force a failure.
    const before = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, created.id));
    expect(before).toHaveLength(1);
    const beforeRow = before[0]!;
    const bookSnapshotBefore = (await db.select().from(books).where(eq(books.id, created.id)))[0]!;

    // Spy seriesMembers.insert by monkey-patching the underlying tx.insert
    // call path: we wrap the BookService.fixMatch transaction by overriding
    // `db.transaction` to invoke the callback then throw mid-flight, AFTER
    // the membership delete but DURING the insert. Easier: pass a payload that
    // forces a primary-key collision on `series_members` by pre-seeding a row
    // with the same id we'd allocate next. SQLite autoincrement makes this
    // unreliable across runs — use a simpler proxy: replace `tx.insert` so the
    // membership insert throws.
    const origTransaction = db.transaction.bind(db);
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation(async (cb: Parameters<typeof origTransaction>[0]) => {
      return origTransaction(async (tx) => {
        const origInsert = tx.insert.bind(tx);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).insert = (table: unknown) => {
          if (table === seriesMembers) {
            throw new Error('forced membership insert failure');
          }
          return origInsert(table as Parameters<typeof origInsert>[0]);
        };
        return cb(tx);
      });
    });

    await expect(svc.fixMatch(created.id, {
      asin: 'B_NEW',
      title: 'New Title',
      authors: [{ name: 'New Author' }],
      narrators: ['New Narrator'],
      seriesName: 'New Series',
      seriesPosition: 5,
      seriesAsin: 'NEW_SID',
    })).rejects.toThrow(/forced membership insert failure/);

    txSpy.mockRestore();

    // Transaction rolled back: book row + old member row are unchanged.
    const bookAfter = (await db.select().from(books).where(eq(books.id, created.id)))[0]!;
    expect(bookAfter.asin).toBe(bookSnapshotBefore.asin);
    expect(bookAfter.title).toBe(bookSnapshotBefore.title);
    expect(bookAfter.seriesName).toBe(bookSnapshotBefore.seriesName);

    const after = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, created.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(beforeRow.id);
  });
});

function log(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>(createMockLogger());
}
