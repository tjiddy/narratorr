import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import { SeriesRefreshService } from './series-refresh.service.js';
import { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

// Issue #1104: housekeeping must prune series cache rows whose members are all
// detached from the library AND that haven't been fetched in over `retentionDays`.
// Newly-created rows (lastFetchedAt = NULL) and rows still anchored by at least
// one linked book must NEVER be deleted.

const ONE_DAY_MS = 86_400_000;

function makeService(db: Db, log: FastifyBaseLogger): SeriesRefreshService {
  // sweepOrphanSeries doesn't touch MetadataService or BookService; pass stubs
  // strong enough to satisfy the constructor without booting the dependency graph.
  const metadataService = inject<MetadataService>({});
  const bookService = new BookService(db, log);
  return new SeriesRefreshService(db, log, metadataService, bookService);
}

describe('SeriesRefreshService.sweepOrphanSeries — housekeeping orphan cleanup (#1104)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-1104-'));
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

  it('picks only series with all-NULL bookId members AND lastFetchedAt older than the cutoff', async () => {
    const now = Date.now();
    const sixtyDaysAgo = new Date(now - 60 * ONE_DAY_MS);
    const fiveDaysAgo = new Date(now - 5 * ONE_DAY_MS);

    // Series A — one linked + one orphan member, last fetched 60 days ago.
    // NOT picked: at least one member has a non-null book_id.
    const [seriesA] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: 'SERIES_A',
        name: 'Series A',
        normalizedName: 'series a',
        lastFetchedAt: sixtyDaysAgo,
      })
      .returning();
    const [bookA] = await db
      .insert(books)
      .values({ title: 'Book A1', asin: 'A1', seriesName: 'Series A', seriesPosition: 1 })
      .returning();
    await db.insert(seriesMembers).values([
      {
        seriesId: seriesA!.id,
        bookId: bookA!.id,
        providerBookId: 'A1',
        title: 'Book A1',
        normalizedTitle: 'book a1',
        authorName: 'Author A',
        positionRaw: '1',
        position: 1,
      },
      {
        seriesId: seriesA!.id,
        bookId: null,
        providerBookId: 'A2',
        title: 'Book A2',
        normalizedTitle: 'book a2',
        authorName: 'Author A',
        positionRaw: '2',
        position: 2,
      },
    ]);

    // Series B — both members orphaned, last fetched 60 days ago.
    // PICKED: orphan + outside grace window.
    const [seriesB] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: 'SERIES_B',
        name: 'Series B',
        normalizedName: 'series b',
        lastFetchedAt: sixtyDaysAgo,
      })
      .returning();
    await db.insert(seriesMembers).values([
      {
        seriesId: seriesB!.id,
        bookId: null,
        providerBookId: 'B1',
        title: 'Book B1',
        normalizedTitle: 'book b1',
        authorName: 'Author B',
        positionRaw: '1',
        position: 1,
      },
      {
        seriesId: seriesB!.id,
        bookId: null,
        providerBookId: 'B2',
        title: 'Book B2',
        normalizedTitle: 'book b2',
        authorName: 'Author B',
        positionRaw: '2',
        position: 2,
      },
    ]);

    // Series C — both orphan members, last fetched 5 days ago.
    // NOT picked: within grace window.
    const [seriesC] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: 'SERIES_C',
        name: 'Series C',
        normalizedName: 'series c',
        lastFetchedAt: fiveDaysAgo,
      })
      .returning();
    await db.insert(seriesMembers).values([
      {
        seriesId: seriesC!.id,
        bookId: null,
        providerBookId: 'C1',
        title: 'Book C1',
        normalizedTitle: 'book c1',
        authorName: 'Author C',
        positionRaw: '1',
        position: 1,
      },
    ]);

    // Series D — zero members, lastFetchedAt = NULL.
    // NOT picked: never-fetched rows are deferred to the next refresh cycle.
    const [seriesD] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: 'SERIES_D',
        name: 'Series D',
        normalizedName: 'series d',
        lastFetchedAt: null,
      })
      .returning();

    const service = makeService(db, log);
    const result = await service.sweepOrphanSeries(30);

    expect(result).toEqual({ deleted: 1 });

    const surviving = await db.select({ id: series.id }).from(series);
    const survivingIds = surviving.map((s) => s.id).sort();
    expect(survivingIds).toEqual([seriesA!.id, seriesC!.id, seriesD!.id].sort());
  });

  it('cascade-deletes series_members rows when the parent series is pruned', async () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * ONE_DAY_MS);
    const [orphanSeries] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: 'ORPHAN1',
        name: 'Orphan Series',
        normalizedName: 'orphan series',
        lastFetchedAt: sixtyDaysAgo,
      })
      .returning();
    await db.insert(seriesMembers).values([
      {
        seriesId: orphanSeries!.id,
        bookId: null,
        providerBookId: 'O1',
        title: 'O1',
        normalizedTitle: 'o1',
        authorName: 'A',
        positionRaw: '1',
        position: 1,
      },
      {
        seriesId: orphanSeries!.id,
        bookId: null,
        providerBookId: 'O2',
        title: 'O2',
        normalizedTitle: 'o2',
        authorName: 'A',
        positionRaw: '2',
        position: 2,
      },
    ]);

    const service = makeService(db, log);
    const result = await service.sweepOrphanSeries(30);

    expect(result).toEqual({ deleted: 1 });

    const childMembers = await db
      .select()
      .from(seriesMembers)
      .where(eq(seriesMembers.seriesId, orphanSeries!.id));
    expect(childMembers).toHaveLength(0);
  });

  it('returns { deleted: 0 } and writes nothing when nothing matches', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * ONE_DAY_MS);
    const [keep] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: 'KEEP',
        name: 'Keep',
        normalizedName: 'keep',
        lastFetchedAt: fiveDaysAgo,
      })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: keep!.id,
      bookId: null,
      providerBookId: 'K1',
      title: 'K1',
      normalizedTitle: 'k1',
      authorName: 'A',
      positionRaw: '1',
      position: 1,
    });

    const service = makeService(db, log);
    const result = await service.sweepOrphanSeries(30);

    expect(result).toEqual({ deleted: 0 });
    const allSeries = await db.select().from(series);
    expect(allSeries).toHaveLength(1);
  });

  // F1 (PR #1111 review): the issue requires non-zero deletions to log
  // { count, names: first 10 } at info AND zero deletions to emit no info line.
  // Direct-against-the-logger coverage so removing the log.info call or
  // dropping the names cap would fail the suite.
  describe('logging contract', () => {
    it('emits a single info log with count and first-10 names on non-zero deletions, capping names at 10', async () => {
      const sixtyDaysAgo = new Date(Date.now() - 60 * ONE_DAY_MS);
      // 12 orphan series — exceeds the 10-name cap so we can verify it.
      const rows = Array.from({ length: 12 }, (_, i) => ({
        provider: 'audible' as const,
        providerSeriesId: `LOG_${i}`,
        name: `Log Series ${String(i).padStart(2, '0')}`,
        normalizedName: `log series ${i}`,
        lastFetchedAt: sixtyDaysAgo,
      }));
      await db.insert(series).values(rows);

      const service = makeService(db, log);
      const result = await service.sweepOrphanSeries(30);

      expect(result).toEqual({ deleted: 12 });
      const infoMock = log.info as unknown as { mock: { calls: Array<[unknown, string]> } };
      const sweepCalls = infoMock.mock.calls.filter(([, msg]) => msg === 'Housekeeping: pruned orphan series');
      expect(sweepCalls).toHaveLength(1);
      const [payload, message] = sweepCalls[0]!;
      expect(message).toBe('Housekeeping: pruned orphan series');
      const typed = payload as { count: number; names: string[] };
      expect(typed.count).toBe(12);
      expect(typed.names).toHaveLength(10);
      // Every logged name corresponds to an actual seeded orphan — no foreign rows
      // sneak into the forensic sample.
      const seededNames = new Set(rows.map((r) => r.name));
      for (const name of typed.names) {
        expect(seededNames.has(name)).toBe(true);
      }
    });

    it('emits no info log when there are zero deletions', async () => {
      // Seed a single survivor so we exercise the predicate but match zero orphans.
      const fiveDaysAgo = new Date(Date.now() - 5 * ONE_DAY_MS);
      await db.insert(series).values({
        provider: 'audible',
        providerSeriesId: 'STILL_FRESH',
        name: 'Still Fresh',
        normalizedName: 'still fresh',
        lastFetchedAt: fiveDaysAgo,
      });

      const service = makeService(db, log);
      const result = await service.sweepOrphanSeries(30);

      expect(result).toEqual({ deleted: 0 });
      const infoMock = log.info as unknown as { mock: { calls: Array<[unknown, string]> } };
      const sweepCalls = infoMock.mock.calls.filter(([, msg]) => msg === 'Housekeeping: pruned orphan series');
      expect(sweepCalls).toHaveLength(0);
    });
  });

  it('chunks deletions to stay under SQLite\'s 999-bind-parameter limit (1200 orphans)', async () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * ONE_DAY_MS);
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      provider: 'audible' as const,
      providerSeriesId: `BULK_${i}`,
      name: `Bulk ${i}`,
      normalizedName: `bulk ${i}`,
      lastFetchedAt: sixtyDaysAgo,
    }));
    // Drizzle's multi-row .values() shares the 999-bind cap; insert in chunks.
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(series).values(rows.slice(i, i + 100));
    }

    const service = makeService(db, log);
    const result = await service.sweepOrphanSeries(30);

    expect(result).toEqual({ deleted: 1200 });
    const remaining = await db
      .select({ id: series.id })
      .from(series)
      .where(inArray(series.providerSeriesId, rows.map((r) => r.providerSeriesId)));
    expect(remaining).toHaveLength(0);
  });
});
