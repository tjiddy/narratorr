import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import { relinkBookToBoundSeries, replaceSeriesLink, upsertSeriesLink } from './book-series-link.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

/**
 * #1139 Bug 1: `upsertSeriesLink` is the book-create / re-import path. When
 * the resolved series row already carries `hardcover_series_id`, it must NOT
 * insert a local row — otherwise the next series-card GET renders the book
 * twice (once via the Hardcover row matched by `findInLibraryMatch`, once via
 * the redundant local row). Asserting "no row" alone is not enough because
 * the helper is best-effort and swallows all throws into `log.warn(...)` —
 * we additionally assert no warn-level log fired during the call.
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
      // libsql may keep the file handle on Windows
    }
  });

  async function seedBook(title: string): Promise<number> {
    const [row] = await db.insert(books).values({ publicId: generatePublicId('bk'), title }).returning();
    return row!.id;
  }

  describe('upsertSeriesLink', () => {
    it('AC1.1: skips the local insert when the series already has hardcover_series_id, with no warn log', async () => {
      const bookId = await seedBook('Bloody Rose');
      // Pre-seed a Hardcover-canonical series row
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
      // The helper swallows throws into log.warn — if the short-circuit threw
      // accidentally, the row count would still pass. Assert no warn fired.
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
      // Hardcover-sourced member for this same bookId (pre-matched by the
      // matcher during the cache-miss persist). This is the original Bug 1
      // setup: with the old `isNull(hardcoverBookId)` filter we'd insert a
      // second local row alongside this one.
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
      // Exactly one row — the Hardcover one — should remain.
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.source).toBe('hardcover');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('AC1.2: inserts a local row when the resolved series has hardcover_series_id IS NULL', async () => {
      const bookId = await seedBook('Bloody Rose');
      // No pre-existing series row — resolveSeriesId will create one with hardcoverSeriesId: null

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
      // First call seeds the series row (hardcoverSeriesId NULL) + the local member
      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });
      // Second call with a different title — should update in place, not duplicate
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
    // AC1.3: Fix Match path is untouched — it still delete-and-inserts a
    // fresh local row regardless of whether the target series has
    // hardcover_series_id set. The known Fix-Match-into-Hardcover-cached
    // duplicate pattern is deliberately deferred to a follow-up issue.
    it('AC1.3: always inserts a fresh local row even when the series has hardcover_series_id', async () => {
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

      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.source).toBe('local');
    });

    it('AC1.3: deletes all prior series_members rows for the book before inserting (replace semantic)', async () => {
      const bookId = await seedBook('Bloody Rose');
      // Seed an existing series + member so we can verify delete-then-insert
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

  // #1228: the dedicated bind re-link helper.
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

      // Emptied old row removed.
      expect(await db.select().from(series).where(eq(series.id, oldRow!.id))).toHaveLength(0);
      // Target row's member preserved (NOT deleted — it equals targetSeriesId).
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

      // The member-row deletion was rolled back.
      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(members).toHaveLength(1);
    });
  });
});
