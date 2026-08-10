/**
 * Add All resolves each member at batch time (#2231), so the resolution outcomes this suite was
 * written for — an ambiguous hold, an exact-title disambiguation, a wrong-sibling avoidance —
 * now happen while the row is being created rather than in the later cron. Rows here are created
 * through the real Add All route against the real resolver, and then still handed to the real
 * `runEnrichment`, because the seeded-series guard has to hold across both.
 *
 * #2202's own integration test proves the resolver's hold on directly-seeded rows, but those rows
 * carry no series, so only here is it observable that an Add All row's `seriesName`/`seriesPosition`
 * survive a hold — and, since #2231, that they survive a resolved match that names another series.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books, bookAuthors, authors } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from './helpers.js';

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchBooks: vi.fn(),
  searchSeries: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  test: vi.fn().mockResolvedValue({ success: true }),
};

const mockAudnexus = {
  name: 'Audnexus',
  type: 'audnexus',
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  getAuthor: vi.fn().mockResolvedValue(null),
  getChapterRuntime: vi.fn().mockResolvedValue({ kind: 'not_found' }),
};

vi.mock('@core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/index.js')>();
  return {
    ...actual,
    METADATA_SEARCH_PROVIDER_FACTORIES: {
      audible: vi.fn().mockImplementation(function () { return mockAudibleProvider; }),
    },
    AudnexusProvider: vi.fn().mockImplementation(function () { return mockAudnexus; }),
  };
});

const AUTHOR = 'Frank Herbert';
const SERIES = 'Dune Chronicles';
/** Deliberately disagrees with the seeded Hardcover series, so the enrichment guard is observable. */
const PROVIDER_SERIES = { name: 'A Different Provider Series', position: 99 };

/** `Dune` is the owned anchor; the other three are created by Add All. */
const MEMBERS = [
  { id: 8001, position: 1, title: 'Dune' },
  { id: 8002, position: 2, title: 'Dune Chronicles Messiah' },
  { id: 8003, position: 3, title: 'Sandworms of Dune' },
  { id: 8004, position: 4, title: 'Heretics of Dune' },
];

describe('Add All rows resolved at batch time, then through the real enrichment job — integration (#2231)', () => {
  let e2e: E2EApp;
  let anchorId: number;
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAudnexus.getBook.mockResolvedValue(null);
    e2e = await createE2EApp();
    await e2e.services.settings.update({ metadata: { hardcoverApiKey: 'TEST_KEY' } });
    anchorId = await seedAnchor();
    mockHardcover();
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await e2e.cleanup();
  });

  async function seedAnchor(): Promise<number> {
    const [book] = await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'), title: 'Dune', seriesName: SERIES, seriesPosition: 1,
    }).returning();
    const [author] = await e2e.db.insert(authors).values({
      publicId: generatePublicId('au'), name: AUTHOR, slug: 'frank-herbert',
    }).returning();
    await e2e.db.insert(bookAuthors).values({ bookId: book!.id, authorId: author!.id, position: 0 });
    return book!.id;
  }

  function mockHardcover(): void {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        series: [{
          id: 4343, name: SERIES, slug: 'dune-chronicles', author: { name: AUTHOR },
          book_series: MEMBERS.map((m) => ({
            position: m.position,
            book: { id: m.id, slug: `s-${m.id}`, title: m.title, image: null, users_count: 50 },
          })),
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;
  }

  /**
   * One window per created row, resolved during the batch:
   * - `Dune Chronicles Messiah` → two pass, neither an exact title → held (the wrong-sibling hazard).
   * - `Sandworms of Dune` → one passes → resolves at create time.
   * - `Heretics of Dune` → several pass but one is an exact title → disambiguated to it, not a sibling.
   */
  function stubWindows(): void {
    mockAudibleProvider.searchBooks.mockImplementation((query: string) => {
      if (query.startsWith('Dune Chronicles Messiah')) {
        return Promise.resolve({ books: [
          { asin: 'B_DUNE', title: 'Dune', authors: [{ name: AUTHOR }] },
          { asin: 'B_MESSIAH', title: 'Dune Messiah', authors: [{ name: AUTHOR }] },
        ] });
      }
      // The resolving candidates carry a CONFLICTING series so the seeded-series guard is the only
      // thing preventing a rewrite — without this the preservation assertion is vacuous.
      if (query.startsWith('Sandworms of Dune')) {
        return Promise.resolve({ books: [
          { asin: 'B_SAND', title: 'Sandworms of Dune', authors: [{ name: AUTHOR }], duration: 2400, seriesPrimary: PROVIDER_SERIES },
        ] });
      }
      // Measured against the real gate: all three pass for row `Heretics of Dune`, and exactly one
      // is an exact title. `Children of Dune`/`God Emperor of Dune` do NOT pass here, so using them
      // would leave a single-candidate window and the disambiguation arm untested.
      if (query.startsWith('Heretics of Dune')) {
        return Promise.resolve({ books: [
          { asin: 'B_DUNE', title: 'Dune', authors: [{ name: AUTHOR }] },
          { asin: 'B_HERETICS', title: 'Heretics of Dune', authors: [{ name: AUTHOR }], duration: 1800, seriesPrimary: PROVIDER_SERIES },
          { asin: 'B_DC_HERETICS', title: 'Dune Chronicles Heretics', authors: [{ name: AUTHOR }] },
        ] });
      }
      return Promise.resolve({ books: [] });
    });
  }

  async function runAddAll() {
    stubWindows();
    const res = await e2e.app.inject({
      method: 'POST',
      url: `/api/books/${anchorId}/series/add-all`,
      payload: { searchImmediately: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requested: 3, created: 3, failed: 0 });
    return res.json();
  }

  /** The cron still runs over the created rows; the seeded series must survive that pass too. */
  async function runAddAllThenEnrichment() {
    await runAddAll();

    // Build the enrichment collaborators the same way the scheduled job does, against this DB.
    const { BookService } = await import('../services/book.service.js');
    const { MetadataService } = await import('../services/metadata.service.js');
    const { runEnrichment } = await import('../jobs/enrichment.js');
    const log = createMockLogger();
    await runEnrichment(
      e2e.db,
      new MetadataService(inject<FastifyBaseLogger>(log)),
      new BookService(e2e.db, inject<FastifyBaseLogger>(log)),
      inject<FastifyBaseLogger>(log),
    );
    return log;
  }

  const rowFor = async (title: string) =>
    (await e2e.db.select().from(books).where(eq(books.title, title)))[0];

  it('creates the single-passing-candidate row already resolved, before any cron has run', async () => {
    await runAddAll();

    const sandworms = await rowFor('Sandworms of Dune');
    // Resolved at batch time: asin and duration are on the row the request created, and the row
    // stays pending so the cron still re-runs it, exactly as an import-list row does.
    expect(sandworms).toMatchObject({ asin: 'B_SAND', duration: 2400, enrichmentStatus: 'pending' });
  });

  it('creates an ambiguous-window member from its own identity, marked failed for the retry window', async () => {
    await runAddAll();

    const held = await rowFor('Dune Chronicles Messiah');
    // No candidate could be proven the row's book, so nothing durable was written onto it — but the
    // member is still accounted for as a row rather than lost.
    expect(held).toMatchObject({
      enrichmentStatus: 'failed',
      asin: null,
      title: 'Dune Chronicles Messiah',
      seriesName: SERIES,
      seriesPosition: 2,
    });
  });

  it('resolves an ambiguous window that contains one exact title to that candidate, never a sibling', async () => {
    await runAddAll();

    const heretics = await rowFor('Heretics of Dune');
    expect(heretics).toMatchObject({ asin: 'B_HERETICS', duration: 1800 });
    // The two other passing candidates in the same window must not have claimed the row — `B_DUNE`
    // is the one a first-match resolver would have taken.
    expect(heretics!.asin).not.toBe('B_DUNE');
    expect(heretics!.asin).not.toBe('B_DC_HERETICS');
  });

  /**
   * The accepted cost of import-list parity: a `failed` row waits out the job's one-hour retry
   * window instead of being re-tried by the next five-minute cycle, and is then retried only while
   * `enrichmentAttempts` stays under the cap — rather than pending forever.
   */
  it('leaves a just-held member untouched by the immediately following cron pass', async () => {
    await runAddAllThenEnrichment();

    const held = await rowFor('Dune Chronicles Messiah');
    expect(held).toMatchObject({ enrichmentStatus: 'failed', asin: null });
    expect(held!.enrichmentAttempts).toBe(0);
  });

  /**
   * Now a create-time assertion as well as an enrichment one: every resolving candidate carries
   * `PROVIDER_SERIES`, so the pin is the only thing keeping the row on the card the operator used.
   */
  it('never rewrites a created row\'s seeded series name or position, whatever the outcome', async () => {
    await runAddAll();

    for (const [title, position] of [['Dune Chronicles Messiah', 2], ['Sandworms of Dune', 3], ['Heretics of Dune', 4]] as const) {
      const row = await rowFor(title);
      expect(row).toMatchObject({ seriesName: SERIES, seriesPosition: position });
    }
  });

  it('keeps the seeded series name and position through the later enrichment pass too', async () => {
    await runAddAllThenEnrichment();

    for (const [title, position] of [['Dune Chronicles Messiah', 2], ['Sandworms of Dune', 3], ['Heretics of Dune', 4]] as const) {
      const row = await rowFor(title);
      expect(row).toMatchObject({ seriesName: SERIES, seriesPosition: position });
    }
  });

  it('leaves the owned anchor untouched by the batch and the job', async () => {
    const before = (await e2e.db.select().from(books).where(eq(books.id, anchorId)))[0];

    await runAddAllThenEnrichment();

    const after = (await e2e.db.select().from(books).where(eq(books.id, anchorId)))[0];
    expect(after!.title).toBe('Dune');
    expect(after!.seriesPosition).toBe(before!.seriesPosition);
  });
});
