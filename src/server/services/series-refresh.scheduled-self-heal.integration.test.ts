import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { selectScheduledCandidates } from './series-refresh.helpers.js';
import { SeriesRefreshService } from './series-refresh.service.js';
import { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

// Issue #1082: scheduled refresh must self-heal contaminated rows the same way
// manual refresh does. The scheduled path historically passed only the cached
// row name + providerSeriesId into reconcileFromBookAsin, which let stale
// cached identity short-circuit resolveTargetIdentity() and re-admit the wrong
// series. The fix plumbs the linked book's seriesName/title/position into the
// candidate and gates providerSeriesId on agreement between the cached row
// name and the linked book's seriesName.

const STORMLIGHT = 'The Stormlight Archive';
const STORMLIGHT_SID = 'B017WJEUOO';
const MISTBORN = 'The Mistborn Saga';
const MISTBORN_SID = 'MISTBORN_SID';
const COSMERE = 'The Cosmere';
const COSMERE_SID = 'COSMERE_SID';
const WARBREAKER = 'Warbreaker';
const WARBREAKER_SID = 'WARBREAKER_SID';

function stormlightProduct(opts: {
  asin: string;
  title: string;
  position: number;
  alsoIn?: Array<{ name: string; asin: string; position?: number }>;
}): BookMetadata {
  const refs = [
    ...(opts.alsoIn ?? []).map((r) =>
      r.position === undefined
        ? { name: r.name, asin: r.asin }
        : { name: r.name, asin: r.asin, position: r.position },
    ),
    { name: STORMLIGHT, asin: STORMLIGHT_SID, position: opts.position },
  ];
  return {
    asin: opts.asin,
    title: opts.title,
    authors: [{ name: 'Brandon Sanderson' }],
    series: refs,
  };
}

function nonStormlightProduct(opts: {
  asin: string;
  title: string;
  refs: Array<{ name: string; asin: string; position?: number }>;
}): BookMetadata {
  return {
    asin: opts.asin,
    title: opts.title,
    authors: [{ name: 'Brandon Sanderson' }],
    series: opts.refs.map((r) =>
      r.position === undefined
        ? { name: r.name, asin: r.asin }
        : { name: r.name, asin: r.asin, position: r.position },
    ),
  };
}

describe('scheduled series refresh — self-heal contaminated rows (#1082)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-1082-'));
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
      // best effort
    }
  });

  describe('selectScheduledCandidates', () => {
    it('returns linked book context (bookId, bookTitle, bookSeriesName, bookSeriesPosition) when at least one local book is linked', async () => {
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: STORMLIGHT_SID,
          name: STORMLIGHT,
          normalizedName: 'the stormlight archive',
        })
        .returning();
      const [book] = await db
        .insert(books)
        .values({
          title: 'Words of Radiance',
          asin: 'WOR1',
          seriesName: STORMLIGHT,
          seriesPosition: 2,
        })
        .returning();
      await db.insert(seriesMembers).values({
        seriesId: seriesRow!.id,
        bookId: book!.id,
        providerBookId: 'WOR1',
        title: 'Words of Radiance',
        normalizedTitle: 'words of radiance',
        authorName: 'Brandon Sanderson',
        positionRaw: '2',
        position: 2,
      });

      const candidates = await selectScheduledCandidates(db);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        id: seriesRow!.id,
        seriesName: STORMLIGHT,
        providerSeriesId: STORMLIGHT_SID,
        seedAsin: 'WOR1',
        bookId: book!.id,
        bookTitle: 'Words of Radiance',
        bookSeriesName: STORMLIGHT,
        bookSeriesPosition: 2,
      });
    });

    it('returns provider-only candidate (no linked book context) when no local book is linked', async () => {
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: STORMLIGHT_SID,
          name: STORMLIGHT,
          normalizedName: 'the stormlight archive',
        })
        .returning();
      // Member with providerBookId only — no books.id link.
      await db.insert(seriesMembers).values({
        seriesId: seriesRow!.id,
        providerBookId: 'WOR1',
        title: 'Words of Radiance',
        normalizedTitle: 'words of radiance',
        authorName: 'Brandon Sanderson',
        positionRaw: '2',
        position: 2,
      });

      const candidates = await selectScheduledCandidates(db);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        id: seriesRow!.id,
        seriesName: STORMLIGHT,
        providerSeriesId: STORMLIGHT_SID,
        seedAsin: 'WOR1',
      });
      expect(candidates[0]!.bookId).toBeUndefined();
      expect(candidates[0]!.bookTitle).toBeUndefined();
      expect(candidates[0]!.bookSeriesName).toBeUndefined();
      expect(candidates[0]!.bookSeriesPosition).toBeUndefined();
    });

    it('selects the lowest-id linked book deterministically when multiple local books are linked to the same row', async () => {
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: STORMLIGHT_SID,
          name: STORMLIGHT,
          normalizedName: 'the stormlight archive',
        })
        .returning();
      const [first] = await db
        .insert(books)
        .values({ title: 'The Way of Kings', asin: 'WOK1', seriesName: STORMLIGHT, seriesPosition: 1 })
        .returning();
      const [second] = await db
        .insert(books)
        .values({ title: 'Words of Radiance', asin: 'WOR1', seriesName: 'Stormlight Archive', seriesPosition: 2 })
        .returning();
      await db.insert(seriesMembers).values({
        seriesId: seriesRow!.id,
        bookId: first!.id,
        providerBookId: 'WOK1',
        title: 'The Way of Kings',
        normalizedTitle: 'the way of kings',
        authorName: 'Brandon Sanderson',
        positionRaw: '1',
        position: 1,
      });
      await db.insert(seriesMembers).values({
        seriesId: seriesRow!.id,
        bookId: second!.id,
        providerBookId: 'WOR1',
        title: 'Words of Radiance',
        normalizedTitle: 'words of radiance',
        authorName: 'Brandon Sanderson',
        positionRaw: '2',
        position: 2,
      });

      const candidates = await selectScheduledCandidates(db);
      expect(candidates).toHaveLength(1);
      // Lowest books.id wins — first inserted is The Way of Kings.
      expect(candidates[0]!.bookId).toBe(first!.id);
      expect(candidates[0]!.bookTitle).toBe('The Way of Kings');
      expect(candidates[0]!.bookSeriesName).toBe(STORMLIGHT);
      expect(candidates[0]!.bookSeriesPosition).toBe(1);
      expect(candidates[0]!.seedAsin).toBe('WOK1');
    });

    it('linked book with null seriesName still surfaces bookId/bookTitle but bookSeriesName is null', async () => {
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: STORMLIGHT_SID,
          name: STORMLIGHT,
          normalizedName: 'the stormlight archive',
        })
        .returning();
      const [book] = await db
        .insert(books)
        .values({
          title: 'Words of Radiance',
          asin: 'WOR1',
          // seriesName intentionally null — provider-only book metadata
        })
        .returning();
      await db.insert(seriesMembers).values({
        seriesId: seriesRow!.id,
        bookId: book!.id,
        providerBookId: 'WOR1',
        title: 'Words of Radiance',
        normalizedTitle: 'words of radiance',
        authorName: 'Brandon Sanderson',
        positionRaw: '2',
        position: 2,
      });

      const candidates = await selectScheduledCandidates(db);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.bookId).toBe(book!.id);
      expect(candidates[0]!.bookSeriesName).toBeNull();
      expect(candidates[0]!.bookSeriesPosition).toBeNull();
    });
  });

  describe('runScheduledRefresh — end-to-end self-heal', () => {
    function makeService(products: BookMetadata[]) {
      const metadataService = inject<MetadataService>({
        getSameSeriesBooks: async (_asin: string) => products,
      });
      const bookService = new BookService(db, log);
      return new SeriesRefreshService(db, log, metadataService, bookService);
    }

    it('reconciles a contaminated row labeled Mistborn but linked to a Stormlight book back to Stormlight', async () => {
      // Seed the production-shaped contamination: row name + providerSeriesId
      // both point at Mistborn, but the linked local book is Words of Radiance
      // with the correct seriesName "The Stormlight Archive".
      const [contaminatedRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: MISTBORN_SID,
          name: MISTBORN,
          normalizedName: 'the mistborn saga',
        })
        .returning();
      const [book] = await db
        .insert(books)
        .values({
          title: 'Words of Radiance',
          asin: 'WOR1',
          seriesName: STORMLIGHT,
          seriesPosition: 2,
        })
        .returning();
      await db.insert(seriesMembers).values({
        seriesId: contaminatedRow!.id,
        bookId: book!.id,
        providerBookId: 'WOR1',
        title: 'Words of Radiance',
        normalizedTitle: 'words of radiance',
        authorName: 'Brandon Sanderson',
        positionRaw: '2',
        position: 2,
      });
      // Other Mistborn-shaped contaminants on the same row.
      await db.insert(seriesMembers).values({
        seriesId: contaminatedRow!.id,
        providerBookId: 'MB1',
        title: 'Mistborn',
        normalizedTitle: 'mistborn',
        authorName: 'Brandon Sanderson',
        positionRaw: '1',
        position: 1,
      });
      await db.insert(seriesMembers).values({
        seriesId: contaminatedRow!.id,
        providerBookId: 'WB1',
        title: 'Warbreaker',
        normalizedTitle: 'warbreaker',
        authorName: 'Brandon Sanderson',
        positionRaw: '1',
        position: 1,
      });

      // Audible returns Stormlight + unrelated series (the production shape).
      const products: BookMetadata[] = [
        stormlightProduct({ asin: 'WOK1', title: 'The Way of Kings', position: 1, alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 50 }] }),
        stormlightProduct({ asin: 'WOR1', title: 'Words of Radiance', position: 2, alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 51 }] }),
        nonStormlightProduct({ asin: 'MB1', title: 'Mistborn', refs: [{ name: MISTBORN, asin: MISTBORN_SID, position: 1 }] }),
        nonStormlightProduct({ asin: 'WB1', title: 'Warbreaker', refs: [{ name: WARBREAKER, asin: WARBREAKER_SID, position: 1 }] }),
      ];
      const service = makeService(products);

      const result = await service.runScheduledRefresh({ sleepMs: async () => undefined });
      expect(result).toEqual({ refreshed: 1, skipped: 0 });

      // Row reconciled to Stormlight identity.
      const healed = (await db.select().from(series).where(eq(series.id, contaminatedRow!.id)))[0]!;
      expect(healed.name).toBe(STORMLIGHT);
      expect(healed.normalizedName).toBe('the stormlight archive');
      expect(healed.providerSeriesId).toBe(STORMLIGHT_SID);

      // Members scoped to Stormlight only.
      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, contaminatedRow!.id));
      const titles = members.map((m) => m.title).sort();
      expect(titles).toEqual(['The Way of Kings', 'Words of Radiance']);
    });

    it('healthy candidate (cached row name agrees with linked book seriesName) refreshes normally with providerSeriesId preserved', async () => {
      const [seriesRow] = await db
        .insert(series)
        .values({
          provider: 'audible',
          providerSeriesId: STORMLIGHT_SID,
          name: STORMLIGHT,
          normalizedName: 'the stormlight archive',
        })
        .returning();
      const [book] = await db
        .insert(books)
        .values({ title: 'Words of Radiance', asin: 'WOR1', seriesName: STORMLIGHT, seriesPosition: 2 })
        .returning();
      await db.insert(seriesMembers).values({
        seriesId: seriesRow!.id,
        bookId: book!.id,
        providerBookId: 'WOR1',
        title: 'Words of Radiance',
        normalizedTitle: 'words of radiance',
        authorName: 'Brandon Sanderson',
        positionRaw: '2',
        position: 2,
      });

      const products: BookMetadata[] = [
        stormlightProduct({ asin: 'WOK1', title: 'The Way of Kings', position: 1 }),
        stormlightProduct({ asin: 'WOR1', title: 'Words of Radiance', position: 2 }),
      ];
      const service = makeService(products);

      const result = await service.runScheduledRefresh({ sleepMs: async () => undefined });
      expect(result).toEqual({ refreshed: 1, skipped: 0 });

      const refreshed = (await db.select().from(series).where(eq(series.id, seriesRow!.id)))[0]!;
      expect(refreshed.name).toBe(STORMLIGHT);
      expect(refreshed.providerSeriesId).toBe(STORMLIGHT_SID);
      expect(refreshed.lastFetchStatus).toBe('success');

      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
      expect(members.map((m) => m.title).sort()).toEqual(['The Way of Kings', 'Words of Radiance']);
    });
  });
});
