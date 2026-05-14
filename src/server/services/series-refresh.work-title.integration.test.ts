import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { applySuccessOutcome, findExistingSeriesRow } from './series-refresh.helpers.js';
import { BookService } from './book.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const SERIES_NAME = 'Red Rising';
const PROVIDER_SERIES_ID = 'RR_SID';

function product(opts: {
  asin: string;
  title: string;
  position: number;
  formatType?: string;
  contentDeliveryType?: string;
  author?: string;
}): BookMetadata {
  return {
    asin: opts.asin,
    title: opts.title,
    authors: [{ name: opts.author ?? 'Pierce Brown' }],
    series: [{ name: SERIES_NAME, position: opts.position, asin: PROVIDER_SERIES_ID }],
    seriesPrimary: { name: SERIES_NAME, position: opts.position, asin: PROVIDER_SERIES_ID },
    formatType: opts.formatType,
    contentDeliveryType: opts.contentDeliveryType,
  };
}

function redRisingFixture(): BookMetadata[] {
  return [
    product({ asin: 'RR_BASE', title: 'Red Rising', position: 1, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
    product({ asin: 'RR_D1', title: 'Red Rising (Part 1 of 2) (Dramatized Adaptation)', position: 1, contentDeliveryType: 'MultiPartBook' }),
    product({ asin: 'RR_D2', title: 'Red Rising (Part 2 of 2) (Dramatized Adaptation)', position: 1, contentDeliveryType: 'MultiPartBook' }),
    product({ asin: 'GS_BASE', title: 'Golden Son', position: 2, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
    product({ asin: 'GS_D1', title: 'Golden Son (Part 1 of 2) (Dramatized Adaptation)', position: 2, contentDeliveryType: 'MultiPartBook' }),
    product({ asin: 'GS_D2', title: 'Golden Son (Part 2 of 2) (Dramatized Adaptation)', position: 2, contentDeliveryType: 'MultiPartBook' }),
  ];
}

describe('series refresh — work-title collapse (#1116)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-work-title-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function refresh(products: BookMetadata[], seedAsin: string) {
    const existing = await findExistingSeriesRow(db, {
      providerSeriesId: PROVIDER_SERIES_ID,
      seriesName: SERIES_NAME,
      seedAsin,
    });
    return applySuccessOutcome(db, log, existing, products, seedAsin, {
      seriesName: SERIES_NAME,
      providerSeriesId: PROVIDER_SERIES_ID,
    });
  }

  it('collapses dramatized split parts into one logical row per position', async () => {
    await refresh(redRisingFixture(), 'RR_BASE');

    const rows = await db.select().from(seriesMembers).orderBy(seriesMembers.position);
    expect(rows).toHaveLength(2);

    const pos1 = rows.find((r) => r.position === 1)!;
    const pos2 = rows.find((r) => r.position === 2)!;

    expect(pos1.providerBookId).toBe('RR_BASE');
    expect(pos1.title).toBe('Red Rising');
    expect(pos1.normalizedTitle).toBe('red rising');
    expect(pos1.alternateAsins.sort()).toEqual(['RR_D1', 'RR_D2']);

    expect(pos2.providerBookId).toBe('GS_BASE');
    expect(pos2.title).toBe('Golden Son');
    expect(pos2.normalizedTitle).toBe('golden son');
    expect(pos2.alternateAsins.sort()).toEqual(['GS_D1', 'GS_D2']);
  });

  it('clean canonical wins even when the user owns a dramatized split locally (F2)', async () => {
    const [localBook] = await db.insert(books).values({ title: 'Golden Son', asin: 'GS_D1' }).returning();
    await refresh(redRisingFixture(), 'RR_BASE');

    const pos2 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 2)))[0]!;
    expect(pos2.providerBookId).toBe('GS_BASE');
    expect(pos2.title).toBe('Golden Son');
    expect(pos2.alternateAsins).toContain('GS_D1');
    expect(pos2.bookId).toBe(localBook!.id);
  });

  it('keeps stripped-title rows distinct when stripped forms differ (no over-collapse)', async () => {
    // Two products at the same position with non-collapsing titles must NOT
    // merge — only the work-title-equality match collapses them.
    await refresh(
      [
        product({ asin: 'X1', title: 'Red Rising', position: 1, formatType: 'unabridged' }),
        product({ asin: 'X2', title: 'Crimson Tide', position: 1, formatType: 'unabridged', author: 'Pierce Brown' }),
      ],
      'X1',
    );
    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1));
    expect(rows).toHaveLength(2);
  });

  it('folds a pre-existing stale noisy row into the clean canonical on refresh (F1)', async () => {
    // Seed a stale row whose stored normalizedTitle is the OLD noisy form.
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'red rising' })
      .returning();
    const [localBook] = await db.insert(books).values({ title: 'Morning Star', asin: 'MS_D1' }).returning();
    const [staleRow] = await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'MS_D1',
      bookId: localBook!.id,
      title: 'Morning Star (Part 1 of 2) (Dramatized Adaptation)',
      // Old (pre-#1116) noisy normalization.
      normalizedTitle: 'morning star part 1 of 2 dramatized adaptation',
      authorName: 'Pierce Brown',
      positionRaw: '3',
      position: 3,
      alternateAsins: [],
    }).returning();

    await refresh(
      [
        product({ asin: 'MS_BASE', title: 'Morning Star', position: 3, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
        product({ asin: 'MS_D1', title: 'Morning Star (Part 1 of 2) (Dramatized Adaptation)', position: 3, contentDeliveryType: 'MultiPartBook' }),
        product({ asin: 'MS_D2', title: 'Morning Star (Part 2 of 2) (Dramatized Adaptation)', position: 3, contentDeliveryType: 'MultiPartBook' }),
      ],
      'MS_BASE',
    );

    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 3));
    expect(rows).toHaveLength(1);
    const surviving = rows[0]!;
    expect(surviving.providerBookId).toBe('MS_BASE');
    expect(surviving.title).toBe('Morning Star');
    expect(surviving.normalizedTitle).toBe('morning star');
    expect(surviving.alternateAsins.sort()).toEqual(['MS_D1', 'MS_D2']);
    expect(surviving.bookId).toBe(localBook!.id);
    // The stale row was either updated in-place OR deleted-then-folded — either
    // way only one row remains. If id matched, the in-place update path fired.
    expect(typeof surviving.id).toBe('number');
    expect(staleRow!.id).toBeDefined();
  });

  it('BookService.upsertSeriesLink reuses the clean canonical when book ASIN is a dramatized split (F1)', async () => {
    // Seed canonical Golden Son row with no alternates yet — the upsert must
    // find it via the work-title in-memory lookup and migrate the book.
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'red rising' })
      .returning();
    const [canonical] = await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'GS_BASE',
      title: 'Golden Son',
      normalizedTitle: 'golden son',
      authorName: 'Pierce Brown',
      positionRaw: '2',
      position: 2,
      alternateAsins: [],
    }).returning();

    const bookService = new BookService(db, log);
    const created = await bookService.create({
      title: 'Golden Son (Part 1 of 2) (Dramatized Adaptation)',
      authors: [{ name: 'Pierce Brown' }],
      asin: 'GS_D1',
      seriesName: SERIES_NAME,
      seriesPosition: 2,
      seriesAsin: PROVIDER_SERIES_ID,
      seriesProvider: 'audible',
    });

    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.id).toBe(canonical!.id);
    expect(members[0]!.bookId).toBe(created.id);
  });

  it('preserves alternates across refreshes when a later response omits them (F3 monotonic)', async () => {
    // First refresh: GS_BASE + GS_D1 + GS_D2.
    await refresh(
      [
        product({ asin: 'GS_BASE', title: 'Golden Son', position: 2, formatType: 'unabridged' }),
        product({ asin: 'GS_D1', title: 'Golden Son (Part 1 of 2) (Dramatized Adaptation)', position: 2 }),
        product({ asin: 'GS_D2', title: 'Golden Son (Part 2 of 2) (Dramatized Adaptation)', position: 2 }),
      ],
      'GS_BASE',
    );
    const afterFirst = (await db.select().from(seriesMembers))[0]!;
    expect(afterFirst.alternateAsins.sort()).toEqual(['GS_D1', 'GS_D2']);

    // Second refresh: only GS_BASE.
    await refresh(
      [product({ asin: 'GS_BASE', title: 'Golden Son', position: 2, formatType: 'unabridged' })],
      'GS_BASE',
    );
    const afterSecond = (await db.select().from(seriesMembers))[0]!;
    expect(afterSecond.id).toBe(afterFirst.id);
    expect(afterSecond.providerBookId).toBe('GS_BASE');
    expect(afterSecond.alternateAsins.sort()).toEqual(['GS_D1', 'GS_D2']);

    // Reachability via dropped alternate still works: insert a local book with
    // GS_D1's ASIN and verify the canonical row links to it on next refresh.
    const [localBook] = await db.insert(books).values({ title: 'Golden Son', asin: 'GS_D1' }).returning();
    await refresh(
      [product({ asin: 'GS_BASE', title: 'Golden Son', position: 2, formatType: 'unabridged' })],
      'GS_BASE',
    );
    const afterThird = (await db.select().from(seriesMembers))[0]!;
    expect(afterThird.bookId).toBe(localBook!.id);
  });

  it('captures displaced providerBookId as alternate when canonical flips (F3)', async () => {
    // Seed an existing canonical that holds a dramatized-split ASIN — state
    // from a refresh-history where the clean variant wasn't returned yet.
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'red rising' })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'GS_D1',
      title: 'Golden Son (Part 1 of 2) (Dramatized Adaptation)',
      // Old noisy normalization — the fold-in path is exercised.
      normalizedTitle: 'golden son part 1 of 2 dramatized adaptation',
      authorName: 'Pierce Brown',
      positionRaw: '2',
      position: 2,
      alternateAsins: [],
    });

    await refresh(
      [
        product({ asin: 'GS_BASE', title: 'Golden Son', position: 2, formatType: 'unabridged' }),
        product({ asin: 'GS_D1', title: 'Golden Son (Part 1 of 2) (Dramatized Adaptation)', position: 2 }),
        product({ asin: 'GS_D2', title: 'Golden Son (Part 2 of 2) (Dramatized Adaptation)', position: 2 }),
      ],
      'GS_BASE',
    );

    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 2));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.providerBookId).toBe('GS_BASE');
    expect(row.alternateAsins.sort()).toEqual(['GS_D1', 'GS_D2']);
    expect(row.alternateAsins).not.toContain('GS_BASE');
  });

  it('keeps alternate_asins monotonic when a non-matching product references the same ASIN (F4)', async () => {
    // Seed a healthy canonical row with two alternates already captured.
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'red rising' })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'GS_BASE',
      title: 'Golden Son',
      normalizedTitle: 'golden son',
      authorName: 'Pierce Brown',
      positionRaw: '2',
      position: 2,
      alternateAsins: ['GS_D1', 'GS_D2'],
    });

    // Refresh with GS_BASE (target-matching) AND a GS_D1 product whose
    // seriesPrimary points at a DIFFERENT series ASIN. F4 contract: the
    // canonical row's alternate_asins MUST remain unchanged — no path in
    // this issue removes individual alternates.
    await refresh(
      [
        product({ asin: 'GS_BASE', title: 'Golden Son', position: 2, formatType: 'unabridged' }),
        {
          asin: 'GS_D1',
          title: 'Golden Son (Part 1 of 2) (Dramatized Adaptation)',
          authors: [{ name: 'Pierce Brown' }],
          series: [{ name: 'Other Series', position: 1, asin: 'OTHER_SID' }],
          seriesPrimary: { name: 'Other Series', position: 1, asin: 'OTHER_SID' },
        },
      ],
      'GS_BASE',
    );

    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 2));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.providerBookId).toBe('GS_BASE');
    expect(row.title).toBe('Golden Son');
    expect(row.alternateAsins.sort()).toEqual(['GS_D1', 'GS_D2']);
  });

  it('collapses split-only candidates into one row when no clean variant exists', async () => {
    await refresh(
      [
        product({ asin: 'D1', title: 'Foo (Part 1 of 2) (Dramatized Adaptation)', position: 1 }),
        product({ asin: 'D2', title: 'Foo (Part 2 of 2) (Dramatized Adaptation)', position: 1 }),
      ],
      'D1',
    );
    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1));
    expect(rows).toHaveLength(1);
    // The canonical providerBookId is one of the splits (deterministic
    // tiebreakers), with the other split captured as alternate.
    const canonical = rows[0]!;
    expect(['D1', 'D2']).toContain(canonical.providerBookId);
    const otherAsin = canonical.providerBookId === 'D1' ? 'D2' : 'D1';
    expect(canonical.alternateAsins).toContain(otherAsin);
  });

  it('idempotent: refreshing twice yields identical alternate_asins and no row churn', async () => {
    await refresh(redRisingFixture(), 'RR_BASE');
    const first = await db.select().from(seriesMembers).orderBy(seriesMembers.id);
    await refresh(redRisingFixture(), 'RR_BASE');
    const second = await db.select().from(seriesMembers).orderBy(seriesMembers.id);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    expect(second.map((r) => r.providerBookId)).toEqual(first.map((r) => r.providerBookId));
    expect(second.map((r) => r.alternateAsins.slice().sort())).toEqual(
      first.map((r) => r.alternateAsins.slice().sort()),
    );
  });
});
