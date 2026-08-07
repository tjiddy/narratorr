import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db, type DbOrTx } from '@db/index.js';
import {
  books,
  bookAuthors,
  bookNarrators,
  authors,
  narrators,
  series,
  seriesMembers,
} from '@db/schema.js';
import { BookService } from './book.service.js';
import { replaceSeriesLink } from './book-series-link.js';
import { SeriesCardService } from './series-card.service.js';
import type { SettingsService } from './settings.service.js';
import { normalizeMemberTitleForMatch } from './series-title-match.js';
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
      subtitle: 'Old Subtitle',
      authors: [{ name: 'Old Author', asin: 'OLDAUTH' }],
      narrators: ['Old Narrator'],
      publisher: 'Old Publisher',
      asin: 'B_OLD',
      seriesName: 'Old Series',
      seriesPosition: 1,
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
      // Maxed-out failed identity: the terminal state Fix Match exists to rescue (#1646).
      enrichmentStatus: 'failed',
      enrichmentAttempts: 5,
    }).where(eq(books.id, created.id));
    return created.id;
  }

  it('series-bearing rematch: replaces scalars, authors, narrators, series link; preserves local state; resets enrichmentStatus', async () => {
    const svc = new BookService(db, log);
    const bookId = await seedBookA(svc);

    const updated = await svc.fixMatch(bookId, {
      asin: 'B_NEW',
      title: 'New Title',
      subtitle: 'New Subtitle',
      authors: [{ name: 'New Author', asin: 'NEWAUTH' }],
      narrators: ['New Narrator'],
      description: 'New description',
      publisher: 'New Publisher',
      coverUrl: 'https://example.com/new.jpg',
      duration: 1200,
      publishedDate: '2024-05-01',
      seriesName: 'New Series',
      seriesPosition: 2,
      genres: ['Fantasy'],
      isbn: '9781234567890',
    });
    expect(updated).not.toBeNull();

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.asin).toBe('B_NEW');
    expect(row!.title).toBe('New Title');
    // Regression guard (#1614): subtitle was declared on FixMatchReplacement but
    // never written by buildFixMatchScalarUpdates; publisher wasn't projected at all.
    expect(row!.subtitle).toBe('New Subtitle');
    expect(row!.publisher).toBe('New Publisher');
    expect(row!.description).toBe('New description');
    expect(row!.coverUrl).toBe('https://example.com/new.jpg');
    expect(row!.duration).toBe(1200);
    expect(row!.publishedDate).toBe('2024-05-01');
    expect(row!.seriesName).toBe('New Series');
    expect(row!.seriesPosition).toBe(2);
    expect(row!.isbn).toBe('9781234567890');
    expect(row!.genres).toEqual(['Fantasy']);
    expect(row!.enrichmentStatus).toBe('pending');
    // Fix Match grants a fresh attempt budget, not the stale count from the wrong identity (#1646).
    expect(row!.enrichmentAttempts).toBe(0);
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
    expect(seriesRow.hardcoverSeriesId).toBeNull();
    expect(seriesRow.normalizedName).toBe('new series');
    expect(members[0]!.source).toBe('local');
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
      // No seriesName / seriesPosition
    });
    expect(updated).not.toBeNull();

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.seriesName).toBeNull();
    expect(row!.seriesPosition).toBeNull();
    expect(row!.asin).toBe('B_STANDALONE');
    // Full-overwrite semantics (#1614): a replacement without subtitle/publisher
    // nulls the previously-stored values (intentional, unlike enrichment).
    expect(row!.subtitle).toBeNull();
    expect(row!.publisher).toBeNull();

    // No membership rows remain for the book
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members).toHaveLength(0);
  });

  // #2069 AC13 — re-identifying a book is a NEW operator assertion, so the prior
  // clears (which described the OLD record) are reset rather than honored.
  it('resets user_cleared_fields to SQL NULL in the same transaction as the scalar replacement', async () => {
    const svc = new BookService(db, log);
    const bookId = await seedBookA(svc);
    await db.update(books).set({ userClearedFields: '["genres","seriesName"]' }).where(eq(books.id, bookId));

    await svc.fixMatch(bookId, {
      asin: 'B_NEW',
      title: 'New Title',
      authors: [{ name: 'New Author' }],
      seriesName: 'New Series',
      seriesPosition: 3,
    });

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.userClearedFields).toBeNull();
    // Asserted from the same read as the replacement itself, so a reset that lands
    // without the scalar rewrite (or vice versa) cannot pass.
    expect(row!.seriesName).toBe('New Series');
    expect(row!.enrichmentStatus).toBe('pending');
  });

  it('leaves the reset rolled back when the transaction fails', async () => {
    const svc = new BookService(db, log);
    const bookId = await seedBookA(svc);
    await db.update(books).set({ userClearedFields: '["genres"]' }).where(eq(books.id, bookId));

    const link = await import('./book-series-link.js');
    const spy = vi.spyOn(link, 'replaceSeriesLink').mockRejectedValueOnce(new Error('link boom'));

    await expect(
      svc.fixMatch(bookId, { asin: 'B_NEW', title: 'New Title', authors: [{ name: 'New Author' }] }),
    ).rejects.toThrow('link boom');
    spy.mockRestore();

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.userClearedFields).toBe('["genres"]');
    expect(row!.title).toBe('Old Title');
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
    const [row] = await db.insert(books).values({ publicId: generatePublicId('bk'), title, asin }).returning();
    return row!.id;
  }

  it('args=null: deletes all prior series_members rows for the book and inserts nothing', async () => {
    const bookId = await insertBookRow('B_NS', 'Standalone');
    const [seriesRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
      name: 'Old Series',
      normalizedName: 'old series',
    }).returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      bookId,
      title: 'Old Title',
      normalizedTitle: 'old title',
      authorName: 'Old Author',
      position: 1,
      source: 'local',
    });

    await db.transaction(async (tx) => {
      await replaceSeriesLink(tx, bookId, null);
    });

    expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(0);
  });

  it('args=payload: deletes prior row(s) AND inserts exactly one new local member', async () => {
    const bookId = await insertBookRow('B_RM', 'Rematched');
    const [oldSeries] = await db.insert(series).values({ publicId: generatePublicId('sr'),
      name: 'Old Series',
      normalizedName: 'old series',
    }).returning();
    await db.insert(seriesMembers).values({
      seriesId: oldSeries!.id,
      bookId,
      title: 'Old Title',
      normalizedTitle: 'old title',
      authorName: 'Old Author',
      position: 1,
      source: 'local',
    });

    await db.transaction(async (tx) => {
      await replaceSeriesLink(tx, bookId, {
        name: 'New Series',
        position: 3,
        title: 'New Title',
        authorName: 'New Author',
      });
    });

    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members).toHaveLength(1);
    const linkedSeries = (await db.select().from(series).where(eq(series.id, members[0]!.seriesId)))[0]!;
    expect(linkedSeries.hardcoverSeriesId).toBeNull();
    expect(linkedSeries.name).toBe('New Series');
    expect(members[0]!.title).toBe('New Title');
    expect(members[0]!.authorName).toBe('New Author');
    expect(members[0]!.position).toBe(3);
    expect(members[0]!.source).toBe('local');
  });

  it('reuses an existing series row when normalizedName matches', async () => {
    const bookId = await insertBookRow('B_REUSE', 'Reuse');
    const [seeded] = await db.insert(series).values({ publicId: generatePublicId('sr'),
      name: 'Seed Series',
      normalizedName: 'seed series',
    }).returning();

    await db.transaction(async (tx) => {
      await replaceSeriesLink(tx, bookId, {
        name: 'Seed Series',
        position: 2,
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

/**
 * #2150 — the operator-visible half. Fix Match onto a Hardcover-canonical series
 * used to seed a `source: 'local'` row, and since #2144 such a row claims its
 * book BEFORE the title matcher runs, so the canonical member rendered '+ Add'
 * for a book the operator owns while the book rendered a second time as its own
 * entry. These build the actual card the modal invalidates
 * (`GET /api/books/:id/series` → `SeriesCardService.getSeriesForBook`).
 */
describe('Fix Match onto a Hardcover-canonical series — card outcome (#2150)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fix-match-card-'));
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

  function cardService(): SeriesCardService {
    return new SeriesCardService(db, log(), inject<SettingsService>({
      get: vi.fn().mockResolvedValue({ hardcoverApiKey: 'hc_key' }),
    }));
  }

  /** A canonical `series` row plus its Hardcover member set — a cache HIT, so no fetch. */
  async function seedCanonicalBand(memberTitles: readonly string[]): Promise<number> {
    const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
      hardcoverSeriesId: 5523,
      name: 'The Band',
      normalizedName: 'the band',
      authorName: 'Nicholas Eames',
      lastFetchedAt: new Date(),
    }).returning();
    let hardcoverBookId = 1000;
    let position = 1;
    for (const title of memberTitles) {
      await db.insert(seriesMembers).values({
        seriesId: row!.id,
        hardcoverBookId: ++hardcoverBookId,
        slug: title.toLowerCase().replace(/\s+/g, '-'),
        title,
        normalizedTitle: normalizeMemberTitleForMatch(title),
        authorName: 'Nicholas Eames',
        position: position++,
        source: 'hardcover',
      });
    }
    return row!.id;
  }

  async function seedOwnedBook(svc: BookService): Promise<number> {
    const created = await svc.create({
      title: 'Wrong Identity',
      authors: [{ name: 'Nicholas Eames' }],
      asin: 'B_WRONG',
      seriesName: 'Some Other Series',
      seriesPosition: 1,
    });
    return created.id;
  }

  // AC7 — the fix. `seriesName` byte-identical to the cached `series.name`.
  it('AC7: the fix-matched book renders as exactly one canonical member with inLibrary, and the card issues no write', async () => {
    const svc = new BookService(db, log());
    const seriesId = await seedCanonicalBand(['Kings of the Wyld', 'Bloody Rose']);
    const bookId = await seedOwnedBook(svc);

    await svc.fixMatch(bookId, {
      asin: 'B_BR', title: 'Bloody Rose', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'The Band', seriesPosition: 2,
    });

    // The matched card takes `buildCardFromCache`'s fast path — assert no
    // transaction is opened, not merely that the row count happens to be right.
    const txSpy = vi.spyOn(db, 'transaction');
    const card = await cardService().getSeriesForBook(bookId);
    expect(txSpy).not.toHaveBeenCalled();
    txSpy.mockRestore();

    expect(card).not.toBeNull();
    expect(card!.hardcoverSeriesId).toBe(5523);
    const owned = card!.members.filter((m) => m.libraryBookId === bookId);
    expect(owned).toHaveLength(1);
    // The surviving entry is the CANONICAL member, not a locally-rendered clone.
    expect(owned[0]!.hardcoverBookId).toBe(1002);
    expect(owned[0]!.inLibrary).toBe(true);
    expect(card!.members).toHaveLength(2);
    expect(card!.members.every((m) => m.hardcoverBookId !== null)).toBe(true);
    // Nothing local was seeded into the canonical series.
    const localRows = await db.select().from(seriesMembers)
      .where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.source, 'local')));
    expect(localRows).toHaveLength(0);
  });

  // AC7 — name-drift variant. The replacement name is normalized-equal but
  // byte-different from the cached `series.name`; the own card loads its pool
  // with the BOOK's `series_name`, which is exactly what Fix Match just wrote,
  // so the book is in its own pool either way.
  it('AC7: a normalized-equal, byte-different replacement series name yields the identical single-entry card', async () => {
    const svc = new BookService(db, log());
    await seedCanonicalBand(['Kings of the Wyld', 'Bloody Rose']);
    const bookId = await seedOwnedBook(svc);

    await svc.fixMatch(bookId, {
      asin: 'B_BR', title: 'Bloody Rose', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'the band', seriesPosition: 2,
    });
    // Fix Match resolved onto the ONE canonical row rather than creating a second.
    const bandRows = await db.select().from(series).where(eq(series.normalizedName, 'the band'));
    expect(bandRows).toHaveLength(1);
    expect(bandRows[0]!.hardcoverSeriesId).toBe(5523);

    const card = await cardService().getSeriesForBook(bookId);
    const owned = card!.members.filter((m) => m.libraryBookId === bookId);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.hardcoverBookId).toBe(1002);
    expect(card!.members).toHaveLength(2);
  });

  // AC8 — the #2144 case: the canonical member set does not contain the book
  // (a dateless Hardcover stub). The card build's reconcile seeds the local row
  // this call site no longer writes, so the book is never invisible.
  it('AC8: a book the canonical member set does not contain still renders, seeded by the card reconcile', async () => {
    const svc = new BookService(db, log());
    const seriesId = await seedCanonicalBand(['Kings of the Wyld']);
    const bookId = await seedOwnedBook(svc);

    await svc.fixMatch(bookId, {
      asin: 'B_OUT', title: 'Outland Interlude', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'The Band', seriesPosition: 3,
    });
    // replaceSeriesLink itself seeded nothing — the reconcile is the only writer.
    expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(0);

    const card = await cardService().getSeriesForBook(bookId);
    const owned = card!.members.filter((m) => m.libraryBookId === bookId);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.title).toBe('Outland Interlude');
    expect(card!.members).toHaveLength(2);

    const seeded = await db.select().from(seriesMembers)
      .where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.source, 'local')));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.bookId).toBe(bookId);
  });

  // AC9 — rollback AFTER the writes were issued. `replaceSeriesLink` is the last
  // awaited step in `fixMatch`'s transaction, so there is no later application
  // step to reject from: let the real callback finish, then throw before commit.
  // A rollback that never reaches the write cannot distinguish a rolled-back
  // mutation from one that never happened, which is why the pre-write case at
  // ':212' is not a substitute for this one.
  it('AC9: a failure after the link writes rolls every series_members row back to its pre-call state', async () => {
    const svc = new BookService(db, log());
    const seriesId = await seedCanonicalBand(['Kings of the Wyld', 'Bloody Rose']);
    const bookId = await seedOwnedBook(svc);
    // A provider row in a SIBLING series (the null-link target) plus the book's
    // own local row (the delete target), so all three write shapes are in flight.
    const [sibling] = await db.insert(series).values({ publicId: generatePublicId('sr'),
      hardcoverSeriesId: 77, name: 'Sibling', normalizedName: 'sibling',
    }).returning();
    await db.insert(seriesMembers).values({
      seriesId: sibling!.id, bookId, hardcoverBookId: 2002, slug: 'sib', title: 'Wrong Identity',
      normalizedTitle: normalizeMemberTitleForMatch('Wrong Identity'), position: 1, source: 'hardcover',
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });

    const snapshot = async (executor: DbOrTx): Promise<string> => JSON.stringify(
      (await executor.select().from(seriesMembers))
        .map((r) => ({ ...r, createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime() }))
        .sort((a, b) => a.id - b.id),
    );
    const before = await snapshot(db);

    // Captured INSIDE the transaction, after the link writes and before the
    // throw. Asserting it differs from `before` is what makes this a POST-write
    // rollback rather than the pre-write case already covered at ':212' — a
    // rollback that never reached the write cannot distinguish the two.
    let uncommitted = '';
    const origTransaction = db.transaction.bind(db);
    const txSpy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (cb: Parameters<typeof origTransaction>[0]) => {
      return origTransaction(async (tx) => {
        await cb(tx);
        uncommitted = await snapshot(tx);
        throw new Error('post-write boom');
      });
    });

    await expect(svc.fixMatch(bookId, {
      asin: 'B_BR', title: 'Bloody Rose', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'The Band', seriesPosition: 2,
    })).rejects.toThrow('post-write boom');
    txSpy.mockRestore();

    expect(uncommitted).not.toBe(before);
    expect(await snapshot(db)).toBe(before);
    // And the scalar half rolled back with it.
    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.asin).toBe('B_WRONG');
    expect(row!.seriesName).toBe('Some Other Series');
    expect(seriesId).toBeGreaterThan(0);
  });
});

function log(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>(createMockLogger());
}
