import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, series, seriesMembers } from '@db/schema.js';
import { detachBookFromSeriesMembers, readPositionClearedBookIds, relinkBookToBoundSeries, replaceSeriesLink, upsertSeriesLink } from './book-series-link.js';
import { normalizeMemberTitleForMatch } from './series-title-match.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

/**
 * #1139: a canonical Hardcover series must not get a redundant local row or render the book twice.
 * The helper is best-effort, so tests also reject errors swallowed into `log.warn`.
 */
describe('book-series-link', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-series-link-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    warnSpy = vi.fn();
    log = inject<FastifyBaseLogger>({ ...createMockLogger(), warn: warnSpy });
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may retain Windows file handles.
    }
  });

  async function seedBook(title: string): Promise<number> {
    const [row] = await db.insert(books).values({ publicId: generatePublicId('bk'), title }).returning();
    return row!.id;
  }

  describe('upsertSeriesLink', () => {
    it('AC1.1: skips the local insert when the series already has hardcover_series_id, with no warn log', async () => {
      const bookId = await seedBook('Bloody Rose');
      await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523,
        name: 'The Band',
        normalizedName: 'the band',
        authorName: 'Nicholas Eames',
        lastFetchedAt: new Date(),
      });

      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      const memberRows = await db.select().from(seriesMembers);
      expect(memberRows).toHaveLength(0);
      // A swallowed short-circuit error would otherwise make the row-count assertion pass.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('AC1.1: skips the local insert even when other (Hardcover-source) rows exist for the book in the same series', async () => {
      const bookId = await seedBook('Bloody Rose');
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523,
        name: 'The Band',
        normalizedName: 'the band',
        authorName: 'Nicholas Eames',
        lastFetchedAt: new Date(),
      }).returning();
      // Seed the pre-matched Hardcover row that the old local-only dedupe missed.
      await db.insert(seriesMembers).values({
        seriesId: seedRow!.id,
        bookId,
        hardcoverBookId: 1002,
        slug: 'bloody',
        title: 'Bloody Rose',
        normalizedTitle: 'bloody rose',
        authorName: 'Nicholas Eames',
        position: 2,
        source: 'hardcover',
      });

      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.source).toBe('hardcover');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('AC1.2: inserts a local row when the resolved series has hardcover_series_id IS NULL', async () => {
      const bookId = await seedBook('Bloody Rose');
      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      const memberRows = await db.select().from(seriesMembers);
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.bookId).toBe(bookId);
      expect(memberRows[0]!.source).toBe('local');
      expect(memberRows[0]!.position).toBe(2);
      expect(warnSpy).not.toHaveBeenCalled();

      // #1443 — resolveSeriesId creates the series with an opaque sr_ publicId.
      const seriesRows = await db.select().from(series);
      expect(seriesRows).toHaveLength(1);
      expect(seriesRows[0]!.publicId).toMatch(/^sr_/);
    });

    it('AC1.2: updates an existing local row when called again with hardcover_series_id IS NULL', async () => {
      const bookId = await seedBook('Bloody Rose');
      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });
      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose (Updated)',
        authorName: 'Nicholas Eames',
      });

      const memberRows = await db.select().from(seriesMembers);
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.title).toBe('Bloody Rose (Updated)');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('replaceSeriesLink', () => {
    // #2150: a local row claims its book before title matching, stealing the canonical member pairing.
    it('#2150 AC5: seeds no local row when the target series is Hardcover-canonical', async () => {
      const bookId = await seedBook('Bloody Rose');
      await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523,
        name: 'The Band',
        normalizedName: 'the band',
        authorName: 'Nicholas Eames',
        lastFetchedAt: new Date(),
      });

      await replaceSeriesLink(db, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(0);
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.source, 'local'))).toHaveLength(0);
    });

    it('#2150 AC6: a non-canonical target still gets exactly one local row, with the full field mapping', async () => {
      const bookId = await seedBook('Bloody Rose');

      await replaceSeriesLink(db, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose: Deluxe',
        authorName: 'Nicholas Eames',
      });

      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.source).toBe('local');
      expect(memberRows[0]!.title).toBe('Bloody Rose: Deluxe');
      expect(memberRows[0]!.normalizedTitle).toBe(normalizeMemberTitleForMatch('Bloody Rose: Deluxe'));
      expect(memberRows[0]!.authorName).toBe('Nicholas Eames');
      expect(memberRows[0]!.position).toBe(2);
      expect(memberRows[0]!.hardcoverBookId).toBeNull();

      const seriesRows = await db.select().from(series);
      expect(seriesRows).toHaveLength(1);
      expect(seriesRows[0]!.hardcoverSeriesId).toBeNull();
    });

    it('#2150 AC3/AC1: deletes the local rows, null-links the provider rows in OTHER series, and bumps their updated_at', async () => {
      const bookId = await seedBook('Bloody Rose');
      const [seriesA] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'Old Series', normalizedName: 'old series',
      }).returning();
      const [seriesB] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 77, name: 'Sibling Series', normalizedName: 'sibling series',
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: seriesA!.id, bookId, title: 'Bloody Rose', normalizedTitle: 'bloody rose', position: 9, source: 'local',
      });
      // Nothing reads `series_members.updated_at`; a stale fixture makes the required bump observable.
      const stale = new Date('2020-01-01T00:00:00Z');
      const [provider] = await db.insert(seriesMembers).values({
        seriesId: seriesB!.id, bookId, hardcoverBookId: 1002, slug: 'bloody', imageUrl: 'https://example.com/br.jpg',
        title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2,
        source: 'hardcover', updatedAt: stale,
      }).returning();

      await replaceSeriesLink(db, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesA!.id))).toHaveLength(0);
      const [survivor] = await db.select().from(seriesMembers).where(eq(seriesMembers.id, provider!.id));
      expect(survivor).toBeDefined();
      expect(survivor!.bookId).toBeNull();
      expect(survivor!.hardcoverBookId).toBe(1002);
      expect(survivor!.slug).toBe('bloody');
      expect(survivor!.imageUrl).toBe('https://example.com/br.jpg');
      expect(survivor!.title).toBe('Bloody Rose');
      expect(survivor!.position).toBe(2);
      expect(survivor!.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
    });

    it('#2150 AC2: a provider row in the TARGET series keeps its book link and its timestamp', async () => {
      const bookId = await seedBook('Bloody Rose');
      const [target] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band',
      }).returning();
      const stale = new Date('2020-01-01T00:00:00Z');
      const [row] = await db.insert(seriesMembers).values({
        seriesId: target!.id, bookId, hardcoverBookId: 1002, slug: 'bloody', title: 'Bloody Rose',
        normalizedTitle: 'bloody rose', position: 2, source: 'hardcover', updatedAt: stale,
      }).returning();

      await replaceSeriesLink(db, bookId, {
        name: 'The Band',
        position: 3,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      const [after] = await db.select().from(seriesMembers).where(eq(seriesMembers.id, row!.id));
      expect(after!.bookId).toBe(bookId);
      expect(after!.updatedAt.getTime()).toBe(stale.getTime());
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.source, 'local'))).toHaveLength(0);
    });

    it('#2150 AC4: args=null deletes the local rows, null-links every provider row, and inserts nothing', async () => {
      const bookId = await seedBook('Bloody Rose');
      const [seriesA] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'Old Series', normalizedName: 'old series',
      }).returning();
      const [seriesB] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 77, name: 'Sibling Series', normalizedName: 'sibling series',
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: seriesA!.id, bookId, title: 'Bloody Rose', normalizedTitle: 'bloody rose', position: 9, source: 'local',
      });
      await db.insert(seriesMembers).values({
        seriesId: seriesB!.id, bookId, hardcoverBookId: 1002, slug: 'bloody', title: 'Bloody Rose',
        normalizedTitle: 'bloody rose', position: 2, source: 'hardcover',
      });

      await replaceSeriesLink(db, bookId, null);

      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId))).toHaveLength(0);
      // Query by series_id because the unlink makes a book_id query blind to the survivor.
      const survivors = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesB!.id));
      expect(survivors).toHaveLength(1);
      expect(survivors[0]!.hardcoverBookId).toBe(1002);
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesA!.id))).toHaveLength(0);
    });

    it('AC1.3: deletes all prior series_members rows for the book before inserting (replace semantic)', async () => {
      const bookId = await seedBook('Bloody Rose');
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'Old Series',
        normalizedName: 'old series',
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: seedRow!.id,
        bookId,
        title: 'Bloody Rose',
        normalizedTitle: 'bloody rose',
        authorName: 'Nicholas Eames',
        position: 99,
        source: 'local',
      });

      await replaceSeriesLink(db, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.position).toBe(2);
    });
  });

  /** #2150 F1: metadata clear shares this total-detach helper; pin its otherwise-unobserved timestamp bump here. */
  describe('detachBookFromSeriesMembers', () => {
    it('#2150 F1: deletes every local row and null-links every provider row, with no series exempted', async () => {
      const bookId = await seedBook('Tress of the Emerald Sea');
      const [localSeries] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'The Cosmere', normalizedName: 'the cosmere',
      }).returning();
      const [providerSeries] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 4242, name: 'Secret Projects', normalizedName: 'secret projects',
      }).returning();
      const [localRow] = await db.insert(seriesMembers).values({
        seriesId: localSeries!.id, bookId, title: 'Tress of the Emerald Sea',
        normalizedTitle: 'tress of the emerald sea', position: 1, source: 'local',
      }).returning();
      const stale = new Date('2020-01-01T00:00:00Z');
      const [providerRow] = await db.insert(seriesMembers).values({
        seriesId: providerSeries!.id, bookId, hardcoverBookId: 4242, slug: 'tress',
        imageUrl: 'https://example.com/tress.jpg', title: 'Tress of the Emerald Sea',
        normalizedTitle: 'tress of the emerald sea', authorName: 'Brandon Sanderson',
        position: 1, source: 'hardcover', updatedAt: stale,
      }).returning();

      await db.transaction((tx) => detachBookFromSeriesMembers(tx, bookId));

      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.id, localRow!.id))).toHaveLength(0);
      const [survivor] = await db.select().from(seriesMembers).where(eq(seriesMembers.id, providerRow!.id));
      expect(survivor).toBeDefined();
      expect(survivor!.bookId).toBeNull();
      expect(survivor!.hardcoverBookId).toBe(4242);
      expect(survivor!.slug).toBe('tress');
      expect(survivor!.imageUrl).toBe('https://example.com/tress.jpg');
      expect(survivor!.title).toBe('Tress of the Emerald Sea');
      expect(survivor!.position).toBe(1);
      expect(survivor!.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
    });

    // `replaceSeriesLink` exempts its target; a total clear must not.
    it('#2150 F1: exempts no series — a provider row is unlinked even in the book\'s own current series', async () => {
      const bookId = await seedBook('Tress of the Emerald Sea');
      const [only] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 4242, name: 'The Cosmere', normalizedName: 'the cosmere',
      }).returning();
      const [row] = await db.insert(seriesMembers).values({
        seriesId: only!.id, bookId, hardcoverBookId: 9001, slug: 'tress', title: 'Tress of the Emerald Sea',
        normalizedTitle: 'tress of the emerald sea', position: 1, source: 'hardcover',
      }).returning();

      await db.transaction((tx) => detachBookFromSeriesMembers(tx, bookId));

      const [after] = await db.select().from(seriesMembers).where(eq(seriesMembers.id, row!.id));
      expect(after!.bookId).toBeNull();
      expect(after!.hardcoverBookId).toBe(9001);
    });
  });

  describe('relinkBookToBoundSeries', () => {
    it('unlinks the book from old series, deletes emptied old rows, and leaves the target untouched', async () => {
      const bookId = await seedBook('A Wizard of Earthsea');
      const [oldRow] = await db.insert(series).values({ publicId: generatePublicId('sr'), name: 'Old', normalizedName: 'old' }).returning();
      await db.insert(seriesMembers).values({
        seriesId: oldRow!.id, bookId, title: 'A Wizard of Earthsea', normalizedTitle: 'a wizard of earthsea', position: 1, source: 'local',
      });
      const [target] = await db.insert(series).values({ publicId: generatePublicId('sr'), hardcoverSeriesId: 4242, name: 'Quartet', normalizedName: 'quartet' }).returning();
      await db.insert(seriesMembers).values({
        seriesId: target!.id, bookId, hardcoverBookId: 1, title: 'A Wizard of Earthsea', normalizedTitle: 'a wizard of earthsea', position: 1, source: 'hardcover',
      });

      await db.transaction((tx) => relinkBookToBoundSeries(tx, bookId, target!.id));

      expect(await db.select().from(series).where(eq(series.id, oldRow!.id))).toHaveLength(0);
      const targetMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, target!.id));
      expect(targetMembers).toHaveLength(1);
      expect(targetMembers[0]!.bookId).toBe(bookId);
    });

    it('keeps an old series row that still has other members after the book is unlinked', async () => {
      const bookId = await seedBook('A Wizard of Earthsea');
      const otherBookId = await seedBook('Another Book');
      const [oldRow] = await db.insert(series).values({ publicId: generatePublicId('sr'), name: 'Old', normalizedName: 'old' }).returning();
      await db.insert(seriesMembers).values([
        { seriesId: oldRow!.id, bookId, title: 'A Wizard of Earthsea', normalizedTitle: 'a wizard of earthsea', position: 1, source: 'local' },
        { seriesId: oldRow!.id, bookId: otherBookId, title: 'Another Book', normalizedTitle: 'another book', position: 2, source: 'local' },
      ]);
      const [target] = await db.insert(series).values({ publicId: generatePublicId('sr'), hardcoverSeriesId: 4242, name: 'Quartet', normalizedName: 'quartet' }).returning();

      await db.transaction((tx) => relinkBookToBoundSeries(tx, bookId, target!.id));

      expect(await db.select().from(series).where(eq(series.id, oldRow!.id))).toHaveLength(1);
      const oldMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, oldRow!.id));
      expect(oldMembers).toHaveLength(1);
      expect(oldMembers[0]!.bookId).toBe(otherBookId);
    });

    it('propagates errors so the caller transaction rolls back', async () => {
      const bookId = await seedBook('A Wizard of Earthsea');
      const [oldRow] = await db.insert(series).values({ publicId: generatePublicId('sr'), name: 'Old', normalizedName: 'old' }).returning();
      await db.insert(seriesMembers).values({
        seriesId: oldRow!.id, bookId, title: 'X', normalizedTitle: 'x', position: 1, source: 'local',
      });

      await expect(db.transaction(async (tx) => {
        await relinkBookToBoundSeries(tx, bookId, 999999);
        throw new Error('boom');
      })).rejects.toThrow('boom');

      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(members).toHaveLength(1);
    });
  });

  describe('readPositionClearedBookIds (#2152 AC9)', () => {
    async function seedWithTombstones(title: string, raw: string | null): Promise<number> {
      const id = await seedBook(title);
      await db.update(books).set({ userClearedFields: raw }).where(eq(books.id, id));
      return id;
    }

    it('returns exactly the ids carrying a live seriesPosition tombstone', async () => {
      const cleared = await seedWithTombstones('Hunters of Dune', '["seriesPosition"]');
      const nameOnly = await seedWithTombstones('Dune Messiah', '["seriesName"]');
      const both = await seedWithTombstones('Children of Dune', '["seriesName","seriesPosition"]');
      const untouched = await seedWithTombstones('Dune', null);

      const result = await readPositionClearedBookIds(db, log, [cleared, nameOnly, both, untouched]);

      expect([...result].sort((a, b) => a - b)).toEqual([cleared, both].sort((a, b) => a - b));
    });

    it('issues ONE batched query for the whole batch, never one per book', async () => {
      const ids = await Promise.all([
        seedWithTombstones('A', '["seriesPosition"]'),
        seedWithTombstones('B', '["seriesPosition"]'),
        seedWithTombstones('C', null),
      ]);
      const handle = { select: vi.fn((...args: unknown[]) => (db.select as (...a: unknown[]) => unknown)(...args)) };

      const result = await readPositionClearedBookIds(inject(handle), log, ids);

      expect(handle.select).toHaveBeenCalledTimes(1);
      expect(result.size).toBe(2);
    });

    it('issues no query at all for an empty batch', async () => {
      const handle = { select: vi.fn() };
      expect(await readPositionClearedBookIds(inject(handle), log, [])).toEqual(new Set());
      expect(handle.select).not.toHaveBeenCalled();
    });

    it('degrades a malformed persisted set to "not cleared" rather than throwing', async () => {
      const corrupt = await seedWithTombstones('Sandworms of Dune', '{oops');
      await expect(readPositionClearedBookIds(db, log, [corrupt])).resolves.toEqual(new Set());
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
