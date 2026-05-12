import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { series, seriesMembers } from '../../db/schema.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { applySuccessOutcome, findExistingSeriesRow } from './series-refresh.helpers.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

// Issue #1078: Audible's `similar_products` for a multi-series book can mix
// products from a broader universe (e.g. The Cosmere) plus several unrelated
// series. The previous code grouped and persisted every candidate, producing
// confidently-wrong Series cards. The fix scopes the refresh to the target
// series identity (provider series ASIN preferred, normalized name fallback).

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
  authorName?: string;
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
    authors: [{ name: opts.authorName ?? 'Brandon Sanderson' }],
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

describe('series refresh — scope to selected series (#1078)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-1078-'));
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

  async function refresh(
    products: BookMetadata[],
    seedAsin: string,
    opts: { seriesName?: string; providerSeriesId?: string | null } = { seriesName: STORMLIGHT, providerSeriesId: STORMLIGHT_SID },
  ) {
    const existing = await findExistingSeriesRow(db, {
      providerSeriesId: opts.providerSeriesId ?? null,
      seriesName: opts.seriesName ?? null,
      seedAsin,
    });
    return applySuccessOutcome(db, log, existing, products, seedAsin, {
      ...(opts.seriesName !== undefined && { seriesName: opts.seriesName }),
      providerSeriesId: opts.providerSeriesId ?? null,
    });
  }

  it('picks the target ref when product lists a broader universe at index 0', async () => {
    // Audible commonly puts the broader universe ref first; the fix must NOT
    // import position from the Cosmere ref (99) when the target is Stormlight.
    const wordsOfRadiance = stormlightProduct({
      asin: 'WOR1',
      title: 'Words of Radiance',
      position: 2,
      alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 99 }],
    });
    await refresh([wordsOfRadiance], 'WOR1');

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(2);
    expect(rows[0]!.positionRaw).toBe('2');
    expect(rows[0]!.title).toBe('Words of Radiance');
  });

  it('matches series ref by normalized name when ASIN is unknown (target "Stormlight Archive" vs "The Stormlight Archive")', async () => {
    // Target name lacks the leading article — Audible's product ref carries it.
    // Strict-equality on the prior `getSeriesRef` would miss this and fall
    // back to series[0] (Cosmere). The fix must match via normalizeSeriesName
    // with leading-article tolerance.
    const product = stormlightProduct({
      asin: 'WOR1',
      title: 'Words of Radiance',
      position: 2,
      alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 99 }],
    });
    await refresh([product], 'WOR1', { seriesName: 'Stormlight Archive', providerSeriesId: null });

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(2);
  });

  it('ASIN match wins over name when target asin is known', async () => {
    // Two refs with the same display title but different ASINs — only the
    // ASIN match should be selected (and its position imported).
    const product: BookMetadata = {
      asin: 'WOR1',
      title: 'Words of Radiance',
      authors: [{ name: 'Brandon Sanderson' }],
      series: [
        // Same display name, different ASIN — must be skipped despite name match.
        { name: STORMLIGHT, asin: 'OTHER_SID', position: 999 },
        { name: STORMLIGHT, asin: STORMLIGHT_SID, position: 2 },
      ],
    };
    await refresh([product], 'WOR1');

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(2);
  });

  it('drops a product whose only series ref is unrelated', async () => {
    const wordsOfRadiance = stormlightProduct({
      asin: 'WOR1',
      title: 'Words of Radiance',
      position: 2,
    });
    const warbreaker = nonStormlightProduct({
      asin: 'WB1',
      title: 'Warbreaker',
      refs: [{ name: WARBREAKER, asin: WARBREAKER_SID, position: 1 }],
    });
    await refresh([wordsOfRadiance, warbreaker], 'WOR1');

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Words of Radiance');
  });

  it('mixed payload — only target-series members are persisted (the deployed Words of Radiance bug shape)', async () => {
    // Reproduce the bug repro from #1078: WoR refresh returns Stormlight +
    // Mistborn + Warbreaker + Cosmere products. Only Stormlight rows survive.
    const products: BookMetadata[] = [
      stormlightProduct({ asin: 'WOK1', title: 'The Way of Kings', position: 1, alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 50 }] }),
      stormlightProduct({ asin: 'WOR1', title: 'Words of Radiance', position: 2, alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 51 }] }),
      stormlightProduct({ asin: 'OB1', title: 'Oathbringer', position: 3 }),
      stormlightProduct({ asin: 'ROW1', title: 'Rhythm of War', position: 4 }),
      nonStormlightProduct({ asin: 'MB1', title: 'Mistborn', refs: [{ name: MISTBORN, asin: MISTBORN_SID, position: 1 }, { name: COSMERE, asin: COSMERE_SID, position: 10 }] }),
      nonStormlightProduct({ asin: 'WOA1', title: 'The Well of Ascension', refs: [{ name: MISTBORN, asin: MISTBORN_SID, position: 2 }] }),
      nonStormlightProduct({ asin: 'WB1', title: 'Warbreaker', refs: [{ name: WARBREAKER, asin: WARBREAKER_SID, position: 1 }, { name: COSMERE, asin: COSMERE_SID, position: 5 }] }),
      // A pure-universe product with no Stormlight ref at all.
      nonStormlightProduct({ asin: 'ARCANUM1', title: 'Arcanum Unbounded', refs: [{ name: COSMERE, asin: COSMERE_SID, position: 100 }] }),
    ];
    await refresh(products, 'WOR1');

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(4);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Oathbringer', 'Rhythm of War', 'The Way of Kings', 'Words of Radiance']);

    // Series row name resolves to the Stormlight ref's display name.
    const seriesRow = (await db.select().from(series))[0]!;
    expect(seriesRow.name).toBe(STORMLIGHT);
    expect(seriesRow.providerSeriesId).toBe(STORMLIGHT_SID);
  });

  it('preserves local state when no products match the target series (mirrors empty-products path)', async () => {
    // Pre-seed a row with a local member so we can assert it survives.
    const [seriesRow] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: STORMLIGHT_SID,
        name: STORMLIGHT,
        normalizedName: 'the stormlight archive',
        lastFetchStatus: 'success',
        lastFetchedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'WOR1',
      title: 'Words of Radiance',
      normalizedTitle: 'words of radiance',
      authorName: 'Brandon Sanderson',
      positionRaw: '2',
      position: 2,
    });

    // Audible returns products but none are Stormlight members.
    const products = [
      nonStormlightProduct({ asin: 'MB1', title: 'Mistborn', refs: [{ name: MISTBORN, asin: MISTBORN_SID, position: 1 }] }),
      nonStormlightProduct({ asin: 'WB1', title: 'Warbreaker', refs: [{ name: WARBREAKER, asin: WARBREAKER_SID, position: 1 }] }),
    ];
    const result = await refresh(products, 'WOR1');

    // Local member preserved
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.providerBookId).toBe('WOR1');

    // Status NOT flipped to 'success' — populated rows keep their existing status,
    // matching the empty-products path in applySuccessOutcome.
    expect(result).not.toBeNull();
    expect(result!.lastFetchStatus).toBe('success'); // populated row keeps status
    expect(result!.lastFetchedAt).not.toBeNull();
  });

  it('reconciles a contaminated row — unrelated stale members get cleared, only target members remain', async () => {
    // Seed the bug-shape: a Stormlight series row that the prior buggy code
    // polluted with Mistborn/Warbreaker rows.
    const [seriesRow] = await db
      .insert(series)
      .values({
        provider: 'audible',
        providerSeriesId: STORMLIGHT_SID,
        name: STORMLIGHT,
        normalizedName: 'the stormlight archive',
      })
      .returning();
    // Stale Mistborn row
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'MB1',
      title: 'Mistborn',
      normalizedTitle: 'mistborn',
      authorName: 'Brandon Sanderson',
      positionRaw: '1',
      position: 1,
    });
    // Stale Warbreaker row
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'WB1',
      title: 'Warbreaker',
      normalizedTitle: 'warbreaker',
      authorName: 'Brandon Sanderson',
      positionRaw: '1',
      position: 1,
    });

    // Refresh returns the same mixed payload — only Stormlight should remain.
    const products: BookMetadata[] = [
      stormlightProduct({ asin: 'WOK1', title: 'The Way of Kings', position: 1 }),
      stormlightProduct({ asin: 'WOR1', title: 'Words of Radiance', position: 2 }),
      nonStormlightProduct({ asin: 'MB1', title: 'Mistborn', refs: [{ name: MISTBORN, asin: MISTBORN_SID, position: 1 }] }),
      nonStormlightProduct({ asin: 'WB1', title: 'Warbreaker', refs: [{ name: WARBREAKER, asin: WARBREAKER_SID, position: 1 }] }),
    ];
    await refresh(products, 'WOR1');

    // The transactional reconcile path replaces stale rows. The two Stormlight
    // members are now the only members; the stale rows are either gone or
    // converted — assert by title rather than relying on internal IDs.
    const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
    const titles = members.map((m) => m.title).sort();
    // Stale Mistborn/Warbreaker may persist as zombie rows OR may be gone —
    // but the Stormlight members must be present and their persisted positions
    // must come from the Stormlight ref, not from a fallback unrelated ref.
    expect(titles).toContain('The Way of Kings');
    expect(titles).toContain('Words of Radiance');
    const wok = members.find((m) => m.title === 'The Way of Kings')!;
    const wor = members.find((m) => m.title === 'Words of Radiance')!;
    expect(wok.position).toBe(1);
    expect(wor.position).toBe(2);
    // Reconciliation removed the stale unrelated rows (they did not survive
    // the refresh because no Stormlight candidate shared their logical
    // identity, and the existing-row preservation only applies to
    // upsert-matched logical keys).
    expect(members.find((m) => m.title === 'Mistborn')).toBeUndefined();
    expect(members.find((m) => m.title === 'Warbreaker')).toBeUndefined();
  });

  it('persisted position comes from the target ref, never from a fallback unrelated ref', async () => {
    // A product whose series array lists Cosmere FIRST with a different
    // position than its Stormlight ref. The prior buggy code grabbed
    // series[0]'s position (Cosmere). The fix imports the Stormlight ref's
    // position only.
    const product = stormlightProduct({
      asin: 'OB1',
      title: 'Oathbringer',
      position: 3,
      alsoIn: [{ name: COSMERE, asin: COSMERE_SID, position: 77 }],
    });
    await refresh([product], 'OB1');

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBe(3);
    expect(rows[0]!.positionRaw).toBe('3');
    // Sanity: not contaminated by Cosmere's position.
    expect(rows[0]!.position).not.toBe(77);
  });

  it('regression — simple single-series response still populates correctly (Bobiverse / Name of the Wind shape)', async () => {
    // Most series — Bobiverse, The Kingkiller Chronicle — Audible returns
    // products with a single series ref. The scoping fix must not regress
    // these cases.
    const products: BookMetadata[] = [
      {
        asin: 'NOTW1',
        title: 'The Name of the Wind',
        authors: [{ name: 'Patrick Rothfuss' }],
        series: [{ name: 'The Kingkiller Chronicle', asin: 'KKC_SID', position: 1 }],
      },
      {
        asin: 'WMF1',
        title: "The Wise Man's Fear",
        authors: [{ name: 'Patrick Rothfuss' }],
        series: [{ name: 'The Kingkiller Chronicle', asin: 'KKC_SID', position: 2 }],
      },
    ];
    await refresh(products, 'NOTW1', { seriesName: 'The Kingkiller Chronicle', providerSeriesId: 'KKC_SID' });

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(2);
    const positions = rows.map((r) => r.position).sort();
    expect(positions).toEqual([1, 2]);
  });
});
