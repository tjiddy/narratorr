import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books, bookAuthors, authors, bookEvents } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';

const ORIGINAL_FETCH = globalThis.fetch;

const AUTHOR = 'James S. A. Corey';

/**
 * The batch resolves every member against the metadata provider before creating it (#2231), so the
 * outbound provider is stubbed the same way the Hardcover fetch is. Each stub deliberately names a
 * different series than the card, which is what makes the pin observable in the durable row.
 */
const RESOLVED: Record<string, Record<string, unknown>> = {
  "Caliban's War": {
    asin: 'B_CALIBAN', title: "Caliban's War", authors: [{ name: AUTHOR }],
    narrators: ['Jefferson Mays'], duration: 1230, coverUrl: 'https://example.test/caliban.jpg',
    seriesPrimary: { name: 'Expanse (Provider Edition)', position: 92 }, formatType: 'unabridged',
  },
  "Abaddon's Gate": {
    asin: 'B_ABADDON', title: "Abaddon's Gate", authors: [{ name: AUTHOR }],
    narrators: ['Jefferson Mays'], duration: 1200, coverUrl: 'https://example.test/abaddon.jpg',
    seriesPrimary: { name: 'Expanse (Provider Edition)', position: 93 }, formatType: 'unabridged',
  },
};

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchBooks: vi.fn().mockImplementation((query: string) => {
    const hit = Object.entries(RESOLVED).find(([title]) => query.startsWith(title));
    return Promise.resolve({ books: hit ? [hit[1]] : [] });
  }),
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

interface HardcoverMember { id: number; position: number | null; title: string }

/**
 * The live-library buckets the major-only invariant was measured against: integer entries are added,
 * fractional novellas, the position-0 prequel and the unpositioned entry are not.
 */
const MEMBERS: HardcoverMember[] = [
  { id: 7001, position: 1, title: 'Leviathan Wakes' },
  { id: 7002, position: 0.1, title: 'Drive' },
  { id: 7003, position: 2, title: "Caliban's War" },
  { id: 7004, position: 2.5, title: 'Gods of Risk' },
  { id: 7005, position: 3, title: "Abaddon's Gate" },
  { id: 7006, position: 0, title: 'The Churn' },
  { id: 7007, position: null, title: 'Unplaced Companion' },
  { id: 7008, position: -1, title: 'Negative Entry' },
];

describe('Series card Add All, E2E (#2200)', () => {
  let e2e: E2EApp;

  beforeEach(async () => {
    vi.clearAllMocks();
    e2e = await createE2EApp();
    await e2e.services.settings.update({ metadata: { hardcoverApiKey: 'TEST_KEY' } });
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await e2e.cleanup();
  });

  async function seedBook(title: string, seriesName: string, position: number | null): Promise<number> {
    const [book] = await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'),
      title,
      seriesName,
      seriesPosition: position,
    }).returning();
    const slug = 'james-s-a-corey';
    const existing = await e2e.db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const authorId = existing[0]?.id
      ?? (await e2e.db.insert(authors).values({ publicId: generatePublicId('au'), name: AUTHOR, slug }).returning())[0]!.id;
    await e2e.db.insert(bookAuthors).values({ bookId: book!.id, authorId, position: 0 });
    return book!.id;
  }

  function mockHardcover(members: HardcoverMember[] = MEMBERS, authorName: string | null = AUTHOR): void {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      data: {
        series: [{
          id: 4242,
          name: 'The Expanse',
          slug: 'the-expanse',
          author: authorName ? { name: authorName } : null,
          book_series: members.map((m) => ({
            position: m.position,
            book: { id: m.id, slug: `s-${m.id}`, title: m.title, image: null, users_count: 100 },
          })),
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof globalThis.fetch;
  }

  function addAll(bookId: number, searchImmediately = false) {
    return e2e.app.inject({
      method: 'POST',
      url: `/api/books/${bookId}/series/add-all`,
      payload: { searchImmediately },
    });
  }

  const titlesIn = async () => (await e2e.db.select().from(books)).map((b) => b.title).sort();

  it('creates a row for each unowned major member and for no excluded member', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    const res = await addAll(anchor);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requested: 2, created: 2, owned: 0, held: 0, failed: 0 });

    const rows = await e2e.db.select().from(books);
    expect(rows.map((r) => r.title).sort()).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);

    const calibans = rows.find((r) => r.title === "Caliban's War")!;
    // Identity is the card's even though the resolved match named a different series and position.
    expect(calibans.seriesName).toBe('The Expanse');
    expect(calibans.seriesPosition).toBe(2);
    expect(calibans.status).toBe('wanted');
    // The row lands complete rather than as a grey placeholder waiting on the enrichment cron.
    expect(calibans.asin).toBe('B_CALIBAN');
    expect(calibans.coverUrl).toBe('https://example.test/caliban.jpg');
    expect(calibans.duration).toBe(1230);
    // Still pending: a resolved row is re-run by the cron exactly as an import-list row is.
    expect(calibans.enrichmentStatus).toBe('pending');

    // Every excluded bucket stayed out of the library entirely.
    for (const excluded of ['Drive', 'Gods of Risk', 'The Churn', 'Unplaced Companion', 'Negative Entry']) {
      expect(rows.some((r) => r.title === excluded)).toBe(false);
    }
  });

  // AC4 of #2305: only ImportListService supplies the exclusion port, so a card member the
  // operator once deleted from an import list is still addable here.
  it('adds a member that an import-list exclusion covers — Add All is deliberately ungated', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    await e2e.services.importListExclusion.recordExclusion(
      { title: "Caliban's War", asin: 'B_CALIBAN', authorName: AUTHOR },
      { importListId: null, importListName: 'NYT Bestsellers' },
    );
    mockHardcover();

    const res = await addAll(anchor);

    expect(res.json()).toMatchObject({ requested: 2, created: 2, failed: 0 });
    expect(await titlesIn()).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);
  });

  it('records the series author as the created row\'s primary author', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    await addAll(anchor);

    const created = (await e2e.db.select().from(books).where(eq(books.title, "Caliban's War")))[0]!;
    const links = await e2e.db.select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(bookAuthors.bookId, created.id));
    expect(links.map((l) => l.name)).toEqual(['James S. A. Corey']);
  });

  it('creates authorless rows when the Hardcover series carries no author', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover(MEMBERS, null);

    const res = await addAll(anchor);

    expect(res.json()).toMatchObject({ created: 2, failed: 0 });
    const created = (await e2e.db.select().from(books).where(eq(books.title, "Caliban's War")))[0]!;
    const links = await e2e.db.select().from(bookAuthors).where(eq(bookAuthors.bookId, created.id));
    expect(links).toEqual([]);
  });

  it('agrees with the database: created equals the number of new rows, and every member is accounted for', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();
    const before = (await e2e.db.select().from(books)).length;

    const body = (await addAll(anchor)).json();

    const after = (await e2e.db.select().from(books)).length;
    expect(after - before).toBe(body.created);
    expect(body.created + body.owned + body.held + body.failed).toBe(body.requested);
    expect(body.members).toHaveLength(body.requested);
    expect(body.members.every((m: { bookId: number | null }) => m.bookId !== null)).toBe(true);
  });

  it('adds nothing on a second sequential run and reports every member as already owned', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    await addAll(anchor);
    const titlesAfterFirst = await titlesIn();

    const second = await addAll(anchor);

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ created: 0, failed: 0 });
    // The first run's rows carry the resolved ASIN and narrators, so the rerun proves them owned
    // rather than abstaining into a hold.
    expect(second.json().members.every((m: { disposition: string }) => m.disposition === 'owned')).toBe(true);
    expect(await titlesIn()).toEqual(titlesAfterFirst);
  });

  /**
   * The #2231 headline, end to end: the operator owns the recording under a title Hardcover did not
   * link, so the member survives selection. Only the resolved ASIN can prove ownership — before the
   * resolve step the batch saw title+author, abstained, and reported the member held forever.
   */
  it('reports an owned-but-unlinked member as owned instead of holding or duplicating it', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'),
      title: "Caliban's War: Expanse Two [Unabridged]",
      asin: 'B_CALIBAN',
      seriesName: 'Something Else',
    });
    mockHardcover();

    const body = (await addAll(anchor)).json();

    const caliban = body.members.find((m: { title: string }) => m.title === "Caliban's War");
    expect(caliban).toMatchObject({ disposition: 'owned' });
    expect(caliban.bookId).not.toBeNull();
    expect((await e2e.db.select().from(books).where(eq(books.title, "Caliban's War"))).length).toBe(0);
  });

  /**
   * Whether the loser is refused by the guard or admitted after the winner released it is a real
   * scheduling race, so these assert the durable outcome both arms must produce. The deterministic
   * 409 itself is pinned where the batch can be held open: `books-series-add-all.test.ts` and
   * `series-add-all.service.test.ts`.
   */
  function expectAdmissionOutcome(responses: Array<{ statusCode: number; json: () => unknown }>): void {
    for (const res of responses) {
      expect([200, 409]).toContain(res.statusCode);
      if (res.statusCode === 409) {
        expect(res.json()).toEqual({ error: 'Add All is already running for this series' });
      }
    }
  }

  it('produces exactly one row per selected member when two requests overlap', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    const responses = await Promise.all([addAll(anchor), addAll(anchor)]);

    expectAdmissionOutcome(responses);
    const rows = await e2e.db.select().from(books);
    expect(rows.map((r) => r.title).sort()).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);
  });

  it('produces exactly one row per member when the overlap comes from a sibling book of the same series', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    const sibling = await seedBook("Abaddon's Gate", 'The Expanse', 3);
    mockHardcover();

    const responses = await Promise.all([addAll(anchor), addAll(sibling)]);

    expectAdmissionOutcome(responses);
    const rows = await e2e.db.select().from(books);
    expect(rows.map((r) => r.title).sort()).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);
  });

  it('admits the series again after a batch, so a transient failure cannot leave it permanently refused', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    await Promise.all([addAll(anchor), addAll(anchor)]);
    const later = await addAll(anchor);

    expect(later.statusCode).toBe(200);
  });

  it('leaves the owned member untouched and never re-adds it', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();
    const before = (await e2e.db.select().from(books).where(eq(books.id, anchor)))[0]!;

    await addAll(anchor);

    const after = (await e2e.db.select().from(books).where(eq(books.id, anchor)))[0]!;
    expect(after).toEqual(before);
    expect((await e2e.db.select().from(books).where(eq(books.title, 'Leviathan Wakes'))).length).toBe(1);
  });

  it('writes a book_added event per created row and no recording_review_skipped event', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    await addAll(anchor);

    const events = await e2e.db.select().from(bookEvents);
    expect(events.filter((e) => e.eventType === 'book_added').map((e) => e.bookTitle).sort())
      .toEqual(["Abaddon's Gate", "Caliban's War"]);
    expect(events.filter((e) => e.eventType === 'recording_review_skipped')).toEqual([]);
  });

  it('returns a zeroed batch and writes nothing for a book with no series', async () => {
    const [loner] = await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'), title: 'Project Hail Mary',
    }).returning();
    mockHardcover();

    const res = await addAll(loner!.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] });
    expect((await e2e.db.select().from(books)).length).toBe(1);
  });

  it('returns a zeroed batch for a library-only card, which has no Hardcover key', async () => {
    await e2e.services.settings.update({ metadata: { hardcoverApiKey: '' } });
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);

    const res = await addAll(anchor);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] });
    expect((await e2e.db.select().from(books)).length).toBe(1);
  });

  it('404s an unknown book id and writes nothing', async () => {
    mockHardcover();

    const res = await addAll(999999);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Book not found' });
    expect((await e2e.db.select().from(books)).length).toBe(0);
  });

  it('400s an omitted searchImmediately and writes nothing', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    const res = await e2e.app.inject({ method: 'POST', url: `/api/books/${anchor}/series/add-all`, payload: {} });

    expect(res.statusCode).toBe(400);
    expect((await e2e.db.select().from(books)).length).toBe(1);
  });

  it('does not persist the searchImmediately flag on the created rows', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    await addAll(anchor, true);

    const created = (await e2e.db.select().from(books).where(eq(books.title, "Caliban's War")))[0]!;
    expect(created).not.toHaveProperty('searchImmediately');
    expect(Object.values(created)).not.toContain('searchImmediately');
  });

  it('re-renders the card with the new members in library after the batch', async () => {
    const anchor = await seedBook('Leviathan Wakes', 'The Expanse', 1);
    mockHardcover();

    await addAll(anchor);
    const card = await e2e.app.inject({ method: 'GET', url: `/api/books/${anchor}/series` });

    const members = card.json().series.members as { title: string; inLibrary: boolean }[];
    const owned = members.filter((m) => m.inLibrary).map((m) => m.title).sort();
    expect(owned).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);
  });
});
