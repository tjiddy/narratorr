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

// Real SQLite coverage owns fixMatch transactions and replaceSeriesLink; route tests mock this boundary.
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
    await db.update(books).set({
      path: '/library/old-path',
      size: 12345,
      audioCodec: 'aac',
      audioBitrate: 128,
      audioFileCount: 1,
      lastGrabGuid: 'guid:old',
      lastGrabInfoHash: 'hash:old',
      // Exercise the exhausted enrichment state that Fix Match must reset.
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
    // Regression guard: subtitle and publisher were previously omitted from scalar updates.
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
    // A new identity receives a fresh enrichment attempt budget.
    expect(row!.enrichmentAttempts).toBe(0);
    expect(row!.path).toBe('/library/old-path');
    expect(row!.size).toBe(12345);
    expect(row!.audioCodec).toBe('aac');
    expect(row!.audioBitrate).toBe(128);
    expect(row!.audioFileCount).toBe(1);
    expect(row!.lastGrabGuid).toBe('guid:old');
    expect(row!.lastGrabInfoHash).toBe('hash:old');

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
    });
    expect(updated).not.toBeNull();

    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.seriesName).toBeNull();
    expect(row!.seriesPosition).toBeNull();
    expect(row!.asin).toBe('B_STANDALONE');
    // Full-overwrite semantics: absent subtitle and publisher become null, unlike enrichment.
    expect(row!.subtitle).toBeNull();
    expect(row!.publisher).toBeNull();

    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
    expect(members).toHaveLength(0);
  });

  // Re-identification resets operator clears that described the old identity.
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
    // One read couples the clear reset to the scalar replacement.
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

  // A blank provider name must clear the series exactly as an absent one does, never seed a blank row (#2224).
  describe('an unusable replacement series name clears rather than blank-names', () => {
    const UNUSABLE = [
      ['empty string', ''],
      ['spaces', '   '],
      ['tab + newline', '\t\n'],
      ['non-breaking space', '\u00A0'],
    ] as const;

    it.each(UNUSABLE)('%s: nullifies both series columns', async (_label, seriesName) => {
      const svc = new BookService(db, log);
      const bookId = await seedBookA(svc);
      await db.update(books).set({ seriesName: 'The Expanse', seriesPosition: 4 }).where(eq(books.id, bookId));

      await svc.fixMatch(bookId, {
        asin: 'B_BLANK',
        title: 'Rematched Title',
        authors: [{ name: 'New Author' }],
        seriesName,
        seriesPosition: 9,
      });

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.seriesName).toBeNull();
      expect(row!.seriesPosition).toBeNull();
    });

    it('detaches the prior link and seeds no blank-named series row', async () => {
      const svc = new BookService(db, log);
      const bookId = await seedBookA(svc);
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(1);

      await svc.fixMatch(bookId, {
        asin: 'B_BLANK',
        title: 'Rematched Title',
        authors: [{ name: 'New Author' }],
        seriesName: '   ',
        seriesPosition: 9,
      });

      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(0);
      expect((await db.select().from(series)).filter((r) => r.normalizedName === '')).toHaveLength(0);
    });

    it('a usable name still replaces the pair and seeds the link (the blank cases are not vacuous)', async () => {
      const svc = new BookService(db, log);
      const bookId = await seedBookA(svc);

      await svc.fixMatch(bookId, {
        asin: 'B_PROVIDER',
        title: 'Rematched Title',
        authors: [{ name: 'New Author' }],
        seriesName: 'Expanse (Provider Edition)',
        seriesPosition: 9,
      });

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.seriesName).toBe('Expanse (Provider Edition)');
      expect(row!.seriesPosition).toBe(9);
      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(members).toHaveLength(1);
      const seriesRow = (await db.select().from(series).where(eq(series.id, members[0]!.seriesId)))[0]!;
      expect(seriesRow.normalizedName).toBe('expanse provider edition');
    });

    it('still resets user_cleared_fields — the series guard leaves the identity-replacement contract alone', async () => {
      const svc = new BookService(db, log);
      const bookId = await seedBookA(svc);
      await db.update(books).set({ userClearedFields: '["genres","seriesName"]' }).where(eq(books.id, bookId));

      await svc.fixMatch(bookId, {
        asin: 'B_BLANK',
        title: 'Rematched Title',
        authors: [{ name: 'New Author' }],
        seriesName: '   ',
      });

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.userClearedFields).toBeNull();
      expect(row!.enrichmentStatus).toBe('pending');
    });
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

    const before = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, created.id));
    expect(before).toHaveLength(1);
    const beforeRow = before[0]!;
    const bookSnapshotBefore = (await db.select().from(books).where(eq(books.id, created.id)))[0]!;

    // Fail the membership insert inside the real transaction after earlier writes have run.
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

    const bookAfter = (await db.select().from(books).where(eq(books.id, created.id)))[0]!;
    expect(bookAfter.asin).toBe(bookSnapshotBefore.asin);
    expect(bookAfter.title).toBe(bookSnapshotBefore.title);
    expect(bookAfter.seriesName).toBe(bookSnapshotBefore.seriesName);

    const after = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, created.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(beforeRow.id);
  });
});

// Seeding a local row before canonical title matching caused a duplicate card entry and false “+ Add”.
// These tests build the real SeriesCardService result consumed by the modal.
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

  /** Seed a canonical cache hit so no provider fetch can alter the fixture. */
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

  it('AC7: the fix-matched book renders as exactly one canonical member with inLibrary, and the card issues no write', async () => {
    const svc = new BookService(db, log());
    const seriesId = await seedCanonicalBand(['Kings of the Wyld', 'Bloody Rose']);
    const bookId = await seedOwnedBook(svc);

    await svc.fixMatch(bookId, {
      asin: 'B_BR', title: 'Bloody Rose', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'The Band', seriesPosition: 2,
    });

    // Pin the cache fast path by asserting it opens no transaction.
    const txSpy = vi.spyOn(db, 'transaction');
    const card = await cardService().getSeriesForBook(bookId);
    expect(txSpy).not.toHaveBeenCalled();
    txSpy.mockRestore();

    expect(card).not.toBeNull();
    expect(card!.hardcoverSeriesId).toBe(5523);
    const owned = card!.members.filter((m) => m.libraryBookId === bookId);
    expect(owned).toHaveLength(1);
    // The surviving entry must be canonical, not a locally rendered clone.
    expect(owned[0]!.hardcoverBookId).toBe(1002);
    expect(owned[0]!.inLibrary).toBe(true);
    expect(card!.members).toHaveLength(2);
    expect(card!.members.every((m) => m.hardcoverBookId !== null)).toBe(true);
    const localRows = await db.select().from(seriesMembers)
      .where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.source, 'local')));
    expect(localRows).toHaveLength(0);
  });

  // The card pools by the just-written book series name, so normalized-equal spelling drift must still match.
  it('AC7: a normalized-equal, byte-different replacement series name yields the identical single-entry card', async () => {
    const svc = new BookService(db, log());
    await seedCanonicalBand(['Kings of the Wyld', 'Bloody Rose']);
    const bookId = await seedOwnedBook(svc);

    await svc.fixMatch(bookId, {
      asin: 'B_BR', title: 'Bloody Rose', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'the band', seriesPosition: 2,
    });
    const bandRows = await db.select().from(series).where(eq(series.normalizedName, 'the band'));
    expect(bandRows).toHaveLength(1);
    expect(bandRows[0]!.hardcoverSeriesId).toBe(5523);

    const card = await cardService().getSeriesForBook(bookId);
    const owned = card!.members.filter((m) => m.libraryBookId === bookId);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.hardcoverBookId).toBe(1002);
    expect(card!.members).toHaveLength(2);
  });

  // When Hardcover lacks the member, only card reconciliation may seed the local fallback.
  it('AC8: a book the canonical member set does not contain still renders, seeded by the card reconcile', async () => {
    const svc = new BookService(db, log());
    const seriesId = await seedCanonicalBand(['Kings of the Wyld']);
    const bookId = await seedOwnedBook(svc);

    await svc.fixMatch(bookId, {
      asin: 'B_OUT', title: 'Outland Interlude', authors: [{ name: 'Nicholas Eames' }],
      seriesName: 'The Band', seriesPosition: 3,
    });
    // replaceSeriesLink seeds nothing here; card reconciliation is the only writer.
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

  // Throw after the real callback because replaceSeriesLink is fixMatch's final awaited step.
  // Requiring changed uncommitted state prevents a pre-write failure from passing vacuously.
  it('AC9: a failure after the link writes rolls every series_members row back to its pre-call state', async () => {
    const svc = new BookService(db, log());
    const seriesId = await seedCanonicalBand(['Kings of the Wyld', 'Bloody Rose']);
    const bookId = await seedOwnedBook(svc);
    // Seed sibling-provider and local rows so null-link, delete, and relink writes all execute.
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
    const [row] = await db.select().from(books).where(eq(books.id, bookId));
    expect(row!.asin).toBe('B_WRONG');
    expect(row!.seriesName).toBe('Some Other Series');
    expect(seriesId).toBeGreaterThan(0);
  });
});

function log(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>(createMockLogger());
}
