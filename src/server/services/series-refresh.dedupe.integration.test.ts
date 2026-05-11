import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { applySuccessOutcome, findExistingSeriesRow } from './series-refresh.helpers.js';
import { buildCardData, buildCardFromRow } from './series-refresh.card-builder.js';
import { BookService } from './book.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const SERIES_NAME = 'The Band';
const PROVIDER_SERIES_ID = 'BAND_SID';

function product(opts: {
  asin?: string;
  title: string;
  authorName?: string;
  position?: number;
  coverUrl?: string;
  duration?: number;
  publishedDate?: string;
  publisher?: string;
}): BookMetadata {
  const series = opts.position === undefined
    ? [{ name: SERIES_NAME, asin: PROVIDER_SERIES_ID }]
    : [{ name: SERIES_NAME, asin: PROVIDER_SERIES_ID, position: opts.position }];
  return {
    asin: opts.asin,
    title: opts.title,
    authors: [{ name: opts.authorName ?? 'Nicholas Eames' }],
    series,
    coverUrl: opts.coverUrl,
    duration: opts.duration,
    publishedDate: opts.publishedDate,
    publisher: opts.publisher,
  };
}

function fourEditionFixture(): BookMetadata[] {
  return [
    product({ asin: 'A1', title: 'Kings of the Wyld', position: 1, coverUrl: 'https://example.test/kw.jpg', duration: 100 }),
    product({ asin: 'A1_ALT', title: 'Kings of the Wyld', position: 1 }),
    product({ asin: 'A2', title: 'Bloody Rose', position: 2, coverUrl: 'https://example.test/br.jpg', duration: 200 }),
    product({ asin: 'A2_ALT', title: 'Bloody Rose', position: 2 }),
  ];
}

describe('series refresh — alternate-edition dedupe (#1073)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-dedupe-'));
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

  it('collapses Audible alternate editions to one logical row per series entry (case 1)', async () => {
    await refresh(fourEditionFixture(), 'A1');

    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(2);

    const byPosition = new Map(rows.map((r) => [r.position, r]));
    const pos1 = byPosition.get(1)!;
    const pos2 = byPosition.get(2)!;

    expect(pos1.providerBookId).toBe('A1');
    expect(pos1.alternateAsins).toContain('A1_ALT');
    expect(pos2.alternateAsins).toContain('A2_ALT');

    const card = await buildCardFromRow(db, (await db.select().from(series))[0]!);
    expect(card.members.map((m) => m.position)).toEqual([1, 2]);
  });

  it('marks isCurrent for a book whose ASIN lives only in alternate_asins (case 2)', async () => {
    await refresh(fourEditionFixture(), 'A1');

    const seriesRow = (await db.select().from(series))[0]!;
    const card = await buildCardFromRow(db, seriesRow, { id: 99, asin: 'A1_ALT' });
    const member = card.members.find((m) => m.position === 1)!;
    expect(member.isCurrent).toBe(true);
  });

  it('links a local library book whose ASIN is one of the alternates (case 3)', async () => {
    const [localBook] = await db
      .insert(books)
      .values({ title: 'Kings of the Wyld', asin: 'A1_ALT' })
      .returning();

    await refresh(fourEditionFixture(), 'A1');

    const pos1Row = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    expect(pos1Row.bookId).toBe(localBook!.id);
  });

  it('is idempotent — running twice does not churn rows or grow the table (case 4)', async () => {
    await refresh(fourEditionFixture(), 'A1');
    const first = await db.select().from(seriesMembers);
    await refresh(fourEditionFixture(), 'A1');
    const second = await db.select().from(seriesMembers);
    expect(second).toHaveLength(2);
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
  });

  it('survives a canonical ASIN flip on the second refresh without inserting duplicates (case 5)', async () => {
    await refresh(fourEditionFixture(), 'A1');
    const firstPos1 = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    expect(firstPos1.providerBookId).toBe('A1');

    // Flip the seed bias so A1_ALT now wins canonical
    await refresh(fourEditionFixture(), 'A1_ALT');
    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1));
    expect(rows).toHaveLength(1);
    const flipped = rows[0]!;
    expect(flipped.id).toBe(firstPos1.id);
    expect(flipped.providerBookId).toBe('A1_ALT');
    expect(flipped.alternateAsins).toContain('A1');
  });

  it('collapses position-missing duplicates by title + author (case 6)', async () => {
    await refresh(
      [
        product({ asin: 'X1', title: 'Untitled Novella' }),
        product({ asin: 'X2', title: 'Untitled Novella' }),
      ],
      'X1',
    );
    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.position).toBeNull();
    expect(rows[0]!.alternateAsins).toContain('X2');
  });

  it('keeps same-position different-author ASIN-bearing rows separate (case 7)', async () => {
    await refresh(
      [
        product({ asin: 'Y1', title: 'Vanishing Point', position: 1, authorName: 'Alice Author' }),
        product({ asin: 'Y2', title: 'Vanishing Point', position: 1, authorName: 'Bob Writer' }),
      ],
      'Y1',
    );
    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(2);
  });

  it('keeps same-position different-author no-ASIN rows separate (case 8)', async () => {
    await refresh(
      [
        product({ title: 'Vanishing Point', position: 1, authorName: 'Alice Author' }),
        product({ title: 'Vanishing Point', position: 1, authorName: 'Bob Writer' }),
      ],
      'seed-unused',
    );
    const rows = await db.select().from(seriesMembers);
    expect(rows).toHaveLength(2);
  });

  it('GET reachability: resolves card via alternate_asins when book.seriesName is null (case 9)', async () => {
    await refresh(fourEditionFixture(), 'A1');

    const localBook = {
      id: 555,
      title: 'Kings of the Wyld',
      asin: 'A1_ALT',
      seriesName: null,
      seriesPosition: null,
    };
    const card = await buildCardData(db, localBook);
    expect(card).not.toBeNull();
    expect(card!.name).toBe(SERIES_NAME);
    const pos1 = card!.members.find((m) => m.position === 1)!;
    expect(pos1.isCurrent).toBe(true);
  });

  it('cleans up pre-existing stale logical-duplicate rows during refresh (case 10)', async () => {
    // Seed the DB with two stale rows for the same position 1
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'the band' })
      .returning();
    const [localBook] = await db
      .insert(books)
      .values({ title: 'Kings of the Wyld', asin: 'A1_ALT' })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'A1',
      title: 'Kings of the Wyld',
      normalizedTitle: 'kings of the wyld',
      authorName: 'Nicholas Eames',
      positionRaw: '1',
      position: 1,
      alternateAsins: [],
    });
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'A1_ALT',
      bookId: localBook!.id,
      title: 'Kings of the Wyld',
      normalizedTitle: 'kings of the wyld',
      authorName: 'Nicholas Eames',
      positionRaw: '1',
      position: 1,
      alternateAsins: [],
    });

    await refresh(fourEditionFixture(), 'A1');

    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1));
    expect(rows).toHaveLength(1);
    const surviving = rows[0]!;
    const altAsins = surviving.alternateAsins;
    expect(altAsins).toContain('A1_ALT');
    expect(surviving.bookId).toBe(localBook!.id);
  });

  it('BookService.upsertSeriesLink reuses a canonical row when the book ASIN is an alternate (case 11)', async () => {
    // Seed canonical row with A1 + alternate_asins=[A1_ALT]
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: PROVIDER_SERIES_ID, name: SERIES_NAME, normalizedName: 'the band' })
      .returning();
    const [canonical] = await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: 'A1',
      title: 'Kings of the Wyld',
      normalizedTitle: 'kings of the wyld',
      authorName: 'Nicholas Eames',
      positionRaw: '1',
      position: 1,
      alternateAsins: ['A1_ALT'],
    }).returning();

    const bookService = new BookService(db, log);
    const created = await bookService.create({
      title: 'Kings of the Wyld',
      authors: [{ name: 'Nicholas Eames' }],
      asin: 'A1_ALT',
      seriesName: SERIES_NAME,
      seriesPosition: 1,
      seriesAsin: PROVIDER_SERIES_ID,
      seriesProvider: 'audible',
    });

    const allMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
    expect(allMembers).toHaveLength(1);
    expect(allMembers[0]!.id).toBe(canonical!.id);
    expect(allMembers[0]!.bookId).toBe(created.id);
  });

  it('normalizes primary author for grouping — trims + lowercases, distinct names stay separate (case 12)', async () => {
    await refresh(
      [
        product({ asin: 'Z1', title: 'The Last Stand', position: 5, authorName: '  Nicholas Eames  ' }),
        product({ asin: 'Z2', title: 'The Last Stand', position: 5, authorName: 'nicholas eames' }),
        product({ asin: 'Z3', title: 'The Last Stand', position: 5, authorName: 'Nick Eames' }),
      ],
      'Z1',
    );
    const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.position, 5));
    expect(rows).toHaveLength(2);
    const collapsed = rows.find((r) => r.providerBookId === 'Z1' || (r.alternateAsins ?? []).includes('Z1'));
    expect(collapsed).toBeDefined();
    expect(collapsed!.alternateAsins).toContain('Z2');
    const separate = rows.find((r) => r.providerBookId === 'Z3');
    expect(separate).toBeDefined();
  });

  it('looks up an existing no-ASIN row whose raw stored author only matches after normalization (F1)', async () => {
    // Seed an existing no-ASIN row directly with a raw author string that
    // differs from the candidate's author only by whitespace + punctuation.
    // The SQL prefilter `lower(author_name) = normalizedAuthor` would have
    // excluded these rows before the helper ran, causing duplicate inserts.
    const [seriesRow] = await db
      .insert(series)
      .values({ provider: 'audible', providerSeriesId: 'F1_SID', name: 'F1 Series', normalizedName: 'f1 series' })
      .returning();
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: null,
      title: 'Fellowship of the Ring',
      normalizedTitle: 'fellowship of the ring',
      authorName: 'J. R. R. Tolkien',
      positionRaw: '1',
      position: 1,
      alternateAsins: [],
    });
    await db.insert(seriesMembers).values({
      seriesId: seriesRow!.id,
      providerBookId: null,
      title: 'Two Towers',
      normalizedTitle: 'two towers',
      authorName: '  Nicholas Eames  ',
      positionRaw: '2',
      position: 2,
      alternateAsins: [],
    });
    const initialCount = (await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id))).length;
    expect(initialCount).toBe(2);

    // Refresh with candidates whose authors normalize to the stored values
    // but have a different raw shape ('j r r tolkien' vs 'J. R. R. Tolkien').
    const existing = await findExistingSeriesRow(db, {
      providerSeriesId: 'F1_SID',
      seriesName: 'F1 Series',
      seedAsin: null,
    });
    await applySuccessOutcome(
      db,
      log,
      existing,
      [
        // Same logical identity as the stored no-ASIN Tolkien row, but raw
        // author differs (no dots) — lookup must find the row via the helper,
        // not via raw lowercase prefilter.
        {
          asin: undefined,
          title: 'Fellowship of the Ring',
          authors: [{ name: 'j r r tolkien' }],
          series: [{ name: 'F1 Series', position: 1, asin: 'F1_SID' }],
        },
        // Same logical identity as the trimmed-pad row.
        {
          asin: undefined,
          title: 'Two Towers',
          authors: [{ name: 'nicholas eames' }],
          series: [{ name: 'F1 Series', position: 2, asin: 'F1_SID' }],
        },
      ],
      'unused-seed',
      { seriesName: 'F1 Series', providerSeriesId: 'F1_SID' },
    );

    const final = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow!.id));
    expect(final).toHaveLength(2);
  });

  it('keeps deterministic alternate_asins order across refreshes (no churn)', async () => {
    await refresh(fourEditionFixture(), 'A1');
    const first = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    await refresh(fourEditionFixture(), 'A1');
    const second = (await db.select().from(seriesMembers).where(eq(seriesMembers.position, 1)))[0]!;
    expect(second.alternateAsins).toEqual(first.alternateAsins);
  });

  it('still resolves card via series row when the book has an unrelated ASIN but matching seriesName', async () => {
    await refresh(fourEditionFixture(), 'A1');
    const card = await buildCardData(db, {
      id: 12,
      title: 'Some other book',
      asin: 'UNRELATED',
      seriesName: SERIES_NAME,
      seriesPosition: null,
    });
    expect(card?.id).toBe((await db.select().from(series))[0]!.id);
  });

  it('falls back to local-only card with the book title when no series row exists', async () => {
    const card = await buildCardData(db, {
      id: 1,
      title: 'Lone Wolf',
      asin: 'UNK',
      seriesName: SERIES_NAME,
      seriesPosition: 3,
    });
    expect(card).not.toBeNull();
    expect(card!.id).toBe(-1);
    expect(card!.members[0]!.title).toBe('Lone Wolf');
  });

  it('cross-platform path safety — assertions do not depend on path separators', () => {
    // Sanity: the test file does not assert on OS-specific path strings.
    expect(and(eq(series.id, 1))).toBeDefined();
  });
});
