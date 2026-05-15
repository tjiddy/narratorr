import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { applySuccessOutcome, findExistingSeriesRow } from './series-refresh.helpers.js';
import { buildCardFromRow } from './series-refresh.card-builder.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const SERIES_NAME = 'The Silo Saga';
const PROVIDER_SERIES_ID = 'B00CXQG7WY';

function product(opts: {
  asin: string;
  title: string;
  position?: number | null;
  author?: string;
  formatType?: string;
  contentDeliveryType?: string;
}): BookMetadata {
  const position = opts.position ?? null;
  const seriesEntry = position === null
    ? { name: SERIES_NAME, asin: PROVIDER_SERIES_ID }
    : { name: SERIES_NAME, position, asin: PROVIDER_SERIES_ID };
  return {
    asin: opts.asin,
    title: opts.title,
    authors: [{ name: opts.author ?? 'Hugh Howey' }],
    series: [seriesEntry],
    seriesPrimary: seriesEntry,
    formatType: opts.formatType,
    contentDeliveryType: opts.contentDeliveryType,
  };
}

function siloFixture(): BookMetadata[] {
  return [
    product({ asin: 'B0BKR3Y6SP', title: 'Wool', position: 1, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
    product({ asin: 'B00AWSTFS8', title: 'Wool', position: 1 }),
    product({ asin: 'B00C7R2NQ8', title: 'Wool', position: 1 }),
    product({ asin: 'B00904FYUI', title: 'Wool Omnibus Edition (Wool 1 - 5)', position: 1 }),
    product({ asin: 'B0BKR7LNQ9', title: 'Shift', position: 2, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
    product({ asin: 'B00CFO6OOU', title: 'Shift', position: 2 }),
    product({ asin: 'B00CONNQLG', title: 'Shift Omnibus Edition', position: 2 }),
    product({ asin: 'B0BKR4Q1PH', title: 'Dust', position: 3, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
    product({ asin: 'B00ELMX0HS', title: 'Dust', position: 3 }),
    product({ asin: 'B00FY0HVJY', title: 'Dust', position: 3 }),
    product({ asin: 'B07623H4SX', title: 'Machine Learning', position: null }),
  ];
}

describe('series refresh — Silo Saga edition/container collapse (#1126)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'silo-saga-'));
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

  it('renders exactly three canonical rows for Wool / Shift / Dust with omnibus ASINs folded into alternateAsins', async () => {
    await refresh(siloFixture(), 'B0BKR3Y6SP');

    const seriesRow = (await db.select().from(series))[0]!;
    // Render the card with the seed book (Wool) as the current book.
    const card = await buildCardFromRow(db, seriesRow, { id: 1, asin: 'B0BKR3Y6SP' });

    // Only positions 1, 2, 3 visible — Machine Learning (null position) hidden.
    expect(card.members.map((m) => m.position)).toEqual([1, 2, 3]);
    expect(card.members.map((m) => m.title)).toEqual(['Wool', 'Shift', 'Dust']);

    // Each canonical row's alternate_asins contains the collapsed siblings
    // (including the omnibus ASINs).
    const pos1 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    expect(pos1.providerBookId).toBe('B0BKR3Y6SP');
    expect(pos1.title).toBe('Wool');
    expect(pos1.alternateAsins.sort()).toEqual(['B00904FYUI', 'B00AWSTFS8', 'B00C7R2NQ8']);

    const pos2 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 2)))[0]!;
    expect(pos2.title).toBe('Shift');
    expect(pos2.alternateAsins).toContain('B00CONNQLG');

    const pos3 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 3)))[0]!;
    expect(pos3.title).toBe('Dust');
  });

  it('imported book with the omnibus ASIN links to the canonical Wool row via alternate_asins', async () => {
    const [localBook] = await db.insert(books).values({ title: 'Wool Omnibus Edition', asin: 'B00904FYUI' }).returning();
    await refresh(siloFixture(), 'B0BKR3Y6SP');

    const pos1 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    expect(pos1.providerBookId).toBe('B0BKR3Y6SP');
    expect(pos1.title).toBe('Wool');
    expect(pos1.alternateAsins).toContain('B00904FYUI');
    expect(pos1.bookId).toBe(localBook!.id);
  });

  it('current-book exception: viewing Machine Learning shows it on the card; viewing Wool hides it', async () => {
    await refresh(siloFixture(), 'B0BKR3Y6SP');

    const seriesRow = (await db.select().from(series))[0]!;
    const machineLearningRow = (await db.select().from(seriesMembers).where(eq(seriesMembers.providerBookId, 'B07623H4SX')))[0]!;

    // Viewing Machine Learning — its row IS visible (current-book exception).
    const cardForML = await buildCardFromRow(db, seriesRow, { id: 99, asin: 'B07623H4SX' });
    expect(cardForML.members.map((m) => m.title)).toEqual(
      expect.arrayContaining(['Wool', 'Shift', 'Dust', 'Machine Learning']),
    );
    expect(cardForML.members).toHaveLength(4);
    const mlInCard = cardForML.members.find((m) => m.providerBookId === 'B07623H4SX')!;
    expect(mlInCard.isCurrent).toBe(true);
    expect(mlInCard.id).toBe(machineLearningRow.id);

    // Viewing Wool — Machine Learning is NOT visible.
    const cardForWool = await buildCardFromRow(db, seriesRow, { id: 1, asin: 'B0BKR3Y6SP' });
    expect(cardForWool.members.map((m) => m.title)).toEqual(['Wool', 'Shift', 'Dust']);
    expect(cardForWool.members.find((m) => m.providerBookId === 'B07623H4SX')).toBeUndefined();
  });

  it('persistence: Machine Learning row IS in series_members even though hidden from the default card', async () => {
    await refresh(siloFixture(), 'B0BKR3Y6SP');

    const allRows = await db.select().from(seriesMembers);
    const mlRow = allRows.find((r) => r.providerBookId === 'B07623H4SX');
    expect(mlRow).toBeDefined();
    expect(mlRow!.position).toBeNull();
  });

  it('seed is Machine Learning (null-position) — row is persisted; viewing it shows the row, viewing other books hides it', async () => {
    // Seed the refresh with the null-position member itself.
    await refresh(siloFixture(), 'B07623H4SX');

    const allRows = await db.select().from(seriesMembers);
    const mlRow = allRows.find((r) => r.providerBookId === 'B07623H4SX')!;
    expect(mlRow.position).toBeNull();

    const seriesRow = (await db.select().from(series))[0]!;

    // Viewing a numbered member (Wool) — ML hidden.
    const cardWool = await buildCardFromRow(db, seriesRow, { id: 1, asin: 'B0BKR3Y6SP' });
    expect(cardWool.members.find((m) => m.providerBookId === 'B07623H4SX')).toBeUndefined();

    // Viewing the null-position seed itself — ML visible.
    const cardML = await buildCardFromRow(db, seriesRow, { id: 99, asin: 'B07623H4SX' });
    expect(cardML.members.find((m) => m.providerBookId === 'B07623H4SX')).toBeDefined();
  });

  it('regression: no null-position row exists for a work that also has a numbered row with the same normalized work title', async () => {
    // Seed a stale null-position omnibus row before the refresh runs — the
    // cleanup sweep must fold it into the numbered canonical.
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'silo saga' })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'STALE_OMNI',
      title: 'Wool Omnibus Edition (Wool 1 - 5)',
      // Old (pre-#1126) noisy normalization with null position.
      normalizedTitle: 'wool omnibus edition wool 1 5',
      authorName: 'Hugh Howey',
      positionRaw: null,
      position: null,
      alternateAsins: [],
    });

    await refresh(siloFixture(), 'B0BKR3Y6SP');

    // The stale null-position row must be folded into the numbered Wool row.
    const nullPosRows = await db
      .select()
      .from(seriesMembers)
      .where(isNull(seriesMembers.position));
    // The only remaining null-position row should be Machine Learning. No
    // null-position row with normalized work title `wool` survives.
    for (const row of nullPosRows) {
      expect(row.providerBookId).not.toBe('STALE_OMNI');
    }
    const woolRow = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    expect(woolRow.alternateAsins).toContain('STALE_OMNI');
  });
});

describe('collection-style series with no numbered members (#1126)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collection-series-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('renders all unnumbered members when no numbered members exist', async () => {
    const SERIES = 'World of Warcraft';
    const SID = 'WOW_SID';
    function p(asin: string, title: string): BookMetadata {
      const entry = { name: SERIES, asin: SID };
      return {
        asin,
        title,
        authors: [{ name: 'Various' }],
        series: [entry],
        seriesPrimary: entry,
      };
    }
    const existing = await findExistingSeriesRow(db, { providerSeriesId: SID, seriesName: SERIES, seedAsin: 'A' });
    await applySuccessOutcome(
      db,
      log,
      existing,
      [p('A', 'Rise of the Horde'), p('B', 'Tides of Darkness'), p('C', 'Lord of the Clans')],
      'A',
      { seriesName: SERIES, providerSeriesId: SID },
    );

    const seriesRow = (await db.select().from(series))[0]!;
    const card = await buildCardFromRow(db, seriesRow, { id: 1, asin: 'A' });
    expect(card.members.map((m) => m.title).sort()).toEqual(['Lord of the Clans', 'Rise of the Horde', 'Tides of Darkness']);
    expect(card.members.every((m) => m.position === null)).toBe(true);
  });
});

describe('only-container-at-numbered-position fallback (#1126)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'only-container-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('preserves the omnibus as canonical when no clean variant exists at the position', async () => {
    const SERIES = 'Test Saga';
    const SID = 'TS_SID';
    const products: BookMetadata[] = [
      product({ asin: 'CLEAN1', title: 'Book One', position: 1 }),
      product({ asin: 'OMNI4', title: 'Saga Omnibus Edition (Books 4 - 6)', position: 4 }),
    ].map((p) => ({
      ...p,
      series: [{ name: SERIES, asin: SID, position: p.seriesPrimary!.position ?? undefined }],
      seriesPrimary: { name: SERIES, asin: SID, position: p.seriesPrimary!.position ?? undefined },
    }));
    const existing = await findExistingSeriesRow(db, { providerSeriesId: SID, seriesName: SERIES, seedAsin: 'CLEAN1' });
    await applySuccessOutcome(db, log, existing, products, 'CLEAN1', { seriesName: SERIES, providerSeriesId: SID });

    const pos4 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 4)))[0]!;
    expect(pos4.providerBookId).toBe('OMNI4');
    expect(pos4.title).toBe('Saga Omnibus Edition (Books 4 - 6)');
  });
});

describe('seed-is-container with clean siblings — F8 visible-title contract (#1126)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'seed-container-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('visible canonical title is the clean row; seed omnibus ASIN is an alternate; current-book flag carries to canonical', async () => {
    // Seed = the omnibus. A clean sibling at the same position exists.
    const [localBook] = await db.insert(books).values({ title: 'Wool Omnibus Edition', asin: 'B00904FYUI' }).returning();
    const SID = 'SILO';
    const products: BookMetadata[] = [
      product({ asin: 'B00904FYUI', title: 'Wool Omnibus Edition (Wool 1 - 5)', position: 1 }),
      product({ asin: 'B0BKR3Y6SP', title: 'Wool', position: 1, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' }),
    ].map((p) => ({
      ...p,
      series: [{ name: SERIES_NAME, asin: SID, position: 1 }],
      seriesPrimary: { name: SERIES_NAME, asin: SID, position: 1 },
    }));
    const existing = await findExistingSeriesRow(db, { providerSeriesId: SID, seriesName: SERIES_NAME, seedAsin: 'B00904FYUI' });
    await applySuccessOutcome(db, log, existing, products, 'B00904FYUI', { seriesName: SERIES_NAME, providerSeriesId: SID });

    const pos1 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    // Visible canonical title is the clean row, not the seed container.
    expect(pos1.title).toBe('Wool');
    expect(pos1.providerBookId).toBe('B0BKR3Y6SP');
    // Seed's ASIN appears in alternate_asins.
    expect(pos1.alternateAsins).toContain('B00904FYUI');
    // Local book linked to the canonical row (the user's omnibus).
    expect(pos1.bookId).toBe(localBook!.id);

    // Render the card with current book = the seed omnibus — the canonical
    // row's isCurrent flag is set (current-book identity carried).
    const seriesRow = (await db.select().from(series))[0]!;
    const card = await buildCardFromRow(db, seriesRow, { id: localBook!.id, asin: 'B00904FYUI' });
    const pos1Card = card.members.find((m) => m.position === 1)!;
    expect(pos1Card.isCurrent).toBe(true);
    expect(pos1Card.title).toBe('Wool');
  });
});
