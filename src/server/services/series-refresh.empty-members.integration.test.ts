import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import { applySuccessOutcome, findExistingSeriesRow } from './series-refresh.helpers.js';
import { buildCardData } from './series-refresh.card-builder.js';
import { BookService } from './book.service.js';
import { SeriesRefreshService } from './series-refresh.service.js';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

// Issue #1074: a deployed Series card can render "No members known yet" even
// after import. Three independent backend bugs combined:
//   (1) buildBookCreatePayload dropped meta.series[0].asin
//   (2) BookService.create refused to upsert a series_members row without seriesAsin
//   (3) applySuccessOutcome flipped lastFetchStatus to 'success' on empty product lists
// Plus a presentation-layer remediation for the resulting historical bad rows.

const SERIES_NAME = 'A Thursday Murder Club Mystery';
const PROVIDER_SERIES_ID = 'B09168SRZK';

describe('issue #1074 — empty-members reconciliation', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-1074-'));
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
      // libsql may keep the file handle on Windows — best effort
    }
  });

  describe('BookService.create — series_members row at create time', () => {
    it('inserts series + series_members rows when seriesName is present without seriesAsin', async () => {
      const service = new BookService(db, log);
      const created = await service.create({
        title: 'The Last Devil to Die',
        authors: [{ name: 'Richard Osman' }],
        asin: 'B0BWLC19B7',
        seriesName: SERIES_NAME,
        seriesPosition: 4,
      });

      const seriesRows = await db.select().from(series);
      expect(seriesRows).toHaveLength(1);
      expect(seriesRows[0]!.providerSeriesId).toBeNull();
      expect(seriesRows[0]!.normalizedName).toBe('a thursday murder club mystery');

      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRows[0]!.id));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.bookId).toBe(created.id);
      expect(memberRows[0]!.title).toBe('The Last Devil to Die');
      expect(memberRows[0]!.providerBookId).toBe('B0BWLC19B7');
      expect(memberRows[0]!.authorName).toBe('Richard Osman');
      expect(memberRows[0]!.position).toBe(4);
    });

    it('reuses an existing series row keyed by providerSeriesId when seriesAsin is supplied', async () => {
      const [seeded] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: PROVIDER_SERIES_ID,
          name: SERIES_NAME,
          normalizedName: 'a thursday murder club mystery',
        })
        .returning();

      const service = new BookService(db, log);
      const created = await service.create({
        title: 'The Last Devil to Die',
        authors: [{ name: 'Richard Osman' }],
        asin: 'B0BWLC19B7',
        seriesName: SERIES_NAME,
        seriesPosition: 4,
        seriesAsin: PROVIDER_SERIES_ID,
        seriesProvider: 'audible',
      });

      const seriesRows = await db.select().from(series);
      expect(seriesRows).toHaveLength(1);
      expect(seriesRows[0]!.id).toBe(seeded!.id);

      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seeded!.id));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.bookId).toBe(created.id);
    });

    it('writes no series rows when seriesName is absent', async () => {
      const service = new BookService(db, log);
      await service.create({
        title: 'Standalone',
        authors: [{ name: 'A. N. Other' }],
        asin: 'STANDALONE1',
      });
      expect(await db.select().from(series)).toHaveLength(0);
      expect(await db.select().from(seriesMembers)).toHaveLength(0);
    });
  });

  describe('applySuccessOutcome — empty provider products', () => {
    it('does not produce a row with lastFetchStatus=success and zero members', async () => {
      const result = await applySuccessOutcome(
        db,
        log,
        null,
        [],
        'B0BWLC19B7',
        { seriesName: SERIES_NAME, providerSeriesId: PROVIDER_SERIES_ID },
      );

      expect(result).toBeNull();
      expect(await db.select().from(series)).toHaveLength(0);
      expect(await db.select().from(seriesMembers)).toHaveLength(0);
    });

    it('preserves an existing local series_members row across an empty refresh', async () => {
      const service = new BookService(db, log);
      const created = await service.create({
        title: 'The Last Devil to Die',
        authors: [{ name: 'Richard Osman' }],
        asin: 'B0BWLC19B7',
        seriesName: SERIES_NAME,
        seriesPosition: 4,
      });
      const existing = await findExistingSeriesRow(db, {
        providerSeriesId: PROVIDER_SERIES_ID,
        seriesName: SERIES_NAME,
        seedAsin: 'B0BWLC19B7',
      });
      expect(existing).not.toBeNull();

      const result = await applySuccessOutcome(
        db,
        log,
        existing,
        [],
        'B0BWLC19B7',
        { seriesName: SERIES_NAME, providerSeriesId: PROVIDER_SERIES_ID },
      );

      expect(result).not.toBeNull();
      expect(result!.lastFetchStatus).not.toBe('success');
      expect(result!.lastFetchedAt).not.toBeNull();

      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, existing!.id));
      expect(members).toHaveLength(1);
      expect(members[0]!.bookId).toBe(created.id);
    });

    it('continues to upsert and mark success when products are populated (regression guard)', async () => {
      const result = await applySuccessOutcome(
        db,
        log,
        null,
        [
          {
            asin: 'B0BWLC19B7',
            title: 'The Last Devil to Die',
            authors: [{ name: 'Richard Osman' }],
            series: [{ name: SERIES_NAME, position: 4, asin: PROVIDER_SERIES_ID }],
          },
        ],
        'B0BWLC19B7',
        { seriesName: SERIES_NAME, providerSeriesId: PROVIDER_SERIES_ID },
      );

      expect(result).not.toBeNull();
      expect(result!.lastFetchStatus).toBe('success');
      expect(await db.select().from(seriesMembers)).toHaveLength(1);
    });
  });

  describe('buildCardData — read-time synthesis for historical zero-member rows', () => {
    async function seedZeroMemberRow() {
      const [row] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: PROVIDER_SERIES_ID,
          name: SERIES_NAME,
          normalizedName: 'a thursday murder club mystery',
          lastFetchStatus: 'success',
          lastFetchedAt: new Date(),
        })
        .returning();
      return row!;
    }

    it('synthesizes the current book when the matching series row has zero members', async () => {
      const seriesRow = await seedZeroMemberRow();
      const [book] = await db
        .insert(books)
        .values({ title: 'The Last Devil to Die', asin: 'B0BWLC19B7', seriesName: SERIES_NAME, seriesPosition: 4 })
        .returning();

      const card = await buildCardData(db, {
        id: book!.id,
        title: book!.title,
        asin: book!.asin,
        seriesName: book!.seriesName,
        seriesPosition: book!.seriesPosition,
      });

      expect(card).not.toBeNull();
      expect(card!.id).toBe(seriesRow.id);
      expect(card!.name).toBe(SERIES_NAME);
      expect(card!.members).toHaveLength(1);
      const member = card!.members[0]!;
      expect(member.title).toBe('The Last Devil to Die');
      expect(member.providerBookId).toBe('B0BWLC19B7');
      expect(member.position).toBe(4);
      expect(member.positionRaw).toBe('4');
      expect(member.isCurrent).toBe(true);
      expect(member.libraryBookId).toBe(book!.id);
      // Author is NOT part of the SeriesMemberCard DTO.
      expect((member as { author?: unknown }).author).toBeUndefined();
      expect((member as { authorName?: unknown }).authorName).toBeUndefined();
    });

    it('preserves the empty state when the current book has no seriesName', async () => {
      await seedZeroMemberRow();
      const [book] = await db
        .insert(books)
        .values({ title: 'Some Other Book', asin: 'UNRELATED', seriesName: null, seriesPosition: null })
        .returning();

      const card = await buildCardData(db, {
        id: book!.id,
        title: book!.title,
        asin: book!.asin,
        seriesName: book!.seriesName,
        seriesPosition: book!.seriesPosition,
      });

      expect(card).toBeNull();
    });

    it('returns real members unchanged when the series row is already populated (regression guard)', async () => {
      const result = await applySuccessOutcome(
        db,
        log,
        null,
        [
          {
            asin: 'B0BWLC19B7',
            title: 'The Last Devil to Die',
            authors: [{ name: 'Richard Osman' }],
            series: [{ name: SERIES_NAME, position: 4, asin: PROVIDER_SERIES_ID }],
          },
        ],
        'B0BWLC19B7',
        { seriesName: SERIES_NAME, providerSeriesId: PROVIDER_SERIES_ID },
      );
      expect(result).not.toBeNull();

      const [book] = await db
        .insert(books)
        .values({ title: 'The Last Devil to Die', asin: 'B0BWLC19B7', seriesName: SERIES_NAME, seriesPosition: 4 })
        .returning();

      const card = await buildCardData(db, {
        id: book!.id,
        title: book!.title,
        asin: book!.asin,
        seriesName: book!.seriesName,
        seriesPosition: book!.seriesPosition,
      });

      expect(card).not.toBeNull();
      expect(card!.members).toHaveLength(1);
      expect(card!.members[0]!.title).toBe('The Last Devil to Die');
    });

    it('falls through to local-only card when no series row exists (regression guard)', async () => {
      const [book] = await db
        .insert(books)
        .values({ title: 'The Last Devil to Die', asin: 'B0BWLC19B7', seriesName: SERIES_NAME, seriesPosition: 4 })
        .returning();

      const card = await buildCardData(db, {
        id: book!.id,
        title: book!.title,
        asin: book!.asin,
        seriesName: book!.seriesName,
        seriesPosition: book!.seriesPosition,
      });

      expect(card).not.toBeNull();
      expect(card!.id).toBe(-1);
      expect(card!.members).toHaveLength(1);
      expect(card!.members[0]!.title).toBe('The Last Devil to Die');
    });
  });

  describe('SeriesRefreshService.reconcileFromBookAsin — manual refresh response synthesis', () => {
    function makeService(products: BookMetadata[]) {
      const metadataService = inject<MetadataService>({
        getSameSeriesBooks: async (_asin: string) => products,
      });
      const bookService = new BookService(db, log);
      return new SeriesRefreshService(db, log, metadataService, bookService);
    }

    it('manual refresh on historical zero-member row + empty provider response returns the synthesized current book (F1)', async () => {
      // Historical state: a real series row marked 'success' with zero members
      // — exactly the deployed bug shape #1074 fixed at create time but left
      // in the wild in DBs that were affected before the fix shipped.
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: PROVIDER_SERIES_ID,
          name: SERIES_NAME,
          normalizedName: 'a thursday murder club mystery',
          lastFetchStatus: 'success',
          lastFetchedAt: new Date(),
        })
        .returning();
      const [book] = await db
        .insert(books)
        .values({ title: 'The Last Devil to Die', asin: 'B0BWLC19B7', seriesName: SERIES_NAME, seriesPosition: 4 })
        .returning();

      const service = makeService([]); // empty same-series provider response
      const response = await service.reconcileFromBookAsin('B0BWLC19B7', {
        manual: true,
        bookId: book!.id,
        seriesName: SERIES_NAME,
        providerSeriesId: PROVIDER_SERIES_ID,
        bookTitle: book!.title,
        seriesPosition: book!.seriesPosition,
      });

      expect(response.status).toBe('refreshed');
      expect(response.series).not.toBeNull();
      expect(response.series!.id).toBe(seriesRow!.id);
      expect(response.series!.members).toHaveLength(1);
      const member = response.series!.members[0]!;
      expect(member.title).toBe('The Last Devil to Die');
      expect(member.providerBookId).toBe('B0BWLC19B7');
      expect(member.position).toBe(4);
      expect(member.isCurrent).toBe(true);
      expect(member.libraryBookId).toBe(book!.id);

      // The DB row is still empty (presentation-layer only — no member is
      // written) — guards against accidental write-through.
      const persistedMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
      expect(persistedMembers).toHaveLength(0);
    });

    it('manual refresh on historical zero-member row + populated provider response writes real members (regression guard)', async () => {
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: PROVIDER_SERIES_ID,
          name: SERIES_NAME,
          normalizedName: 'a thursday murder club mystery',
          lastFetchStatus: 'success',
        })
        .returning();
      const [book] = await db
        .insert(books)
        .values({ title: 'The Last Devil to Die', asin: 'B0BWLC19B7', seriesName: SERIES_NAME, seriesPosition: 4 })
        .returning();

      const service = makeService([
        {
          asin: '0593289501',
          title: 'The Thursday Murder Club',
          authors: [{ name: 'Richard Osman' }],
          series: [{ name: SERIES_NAME, position: 1, asin: PROVIDER_SERIES_ID }],
        },
        {
          asin: 'B0BWLC19B7',
          title: 'The Last Devil to Die',
          authors: [{ name: 'Richard Osman' }],
          series: [{ name: SERIES_NAME, position: 4, asin: PROVIDER_SERIES_ID }],
        },
      ]);
      const response = await service.reconcileFromBookAsin('B0BWLC19B7', {
        manual: true,
        bookId: book!.id,
        seriesName: SERIES_NAME,
        providerSeriesId: PROVIDER_SERIES_ID,
        bookTitle: book!.title,
        seriesPosition: book!.seriesPosition,
      });

      expect(response.status).toBe('refreshed');
      expect(response.series!.members.length).toBeGreaterThanOrEqual(2);
      // Real members were persisted — not the -1 synthesized placeholder.
      const persistedMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
      expect(persistedMembers).toHaveLength(2);
    });
  });

  describe('end-to-end — import + empty refresh produces a card with the current book', () => {
    it('Series card shows the current book after an empty same-series response', async () => {
      const service = new BookService(db, log);
      const created = await service.create({
        title: 'The Last Devil to Die',
        authors: [{ name: 'Richard Osman' }],
        asin: 'B0BWLC19B7',
        seriesName: SERIES_NAME,
        seriesPosition: 4,
        seriesAsin: PROVIDER_SERIES_ID,
        seriesProvider: 'audible',
      });

      const existing = await findExistingSeriesRow(db, {
        providerSeriesId: PROVIDER_SERIES_ID,
        seriesName: SERIES_NAME,
        seedAsin: 'B0BWLC19B7',
      });
      await applySuccessOutcome(db, log, existing, [], 'B0BWLC19B7', {
        seriesName: SERIES_NAME,
        providerSeriesId: PROVIDER_SERIES_ID,
      });

      const card = await buildCardData(db, {
        id: created.id,
        title: created.title,
        asin: created.asin ?? null,
        seriesName: created.seriesName,
        seriesPosition: created.seriesPosition,
      });

      expect(card).not.toBeNull();
      expect(card!.members.length).toBeGreaterThan(0);
      expect(card!.members[0]!.title).toBe('The Last Devil to Die');
      expect(card!.members[0]!.isCurrent).toBe(true);
    });
  });
});
