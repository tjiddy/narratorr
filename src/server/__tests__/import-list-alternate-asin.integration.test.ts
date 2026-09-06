/**
 * A Hardcover `default_audio_edition.asin` can be a genuine Audible edition that Audnexus does not
 * serve, while a sibling in the same `editions[]` payload does (#2611). Everything from the seed to
 * the durable row is real here — the real `MetadataService`, the real `resolveBook` probe loop, the
 * real intake pipeline, real database writes — with only the two outbound providers and the list
 * adapter stubbed, so `mockAudnexus.getBook` is the per-ASIN seam the fix has to move.
 *
 * NOT an extension of `import-list-run.e2e.test.ts`: that suite stubs `resolveBook` itself, which is
 * the function under test here, and its fail-closed `fetch` inventory would have to be relaxed to
 * admit a metadata provider. This is the `series-add-all-enrichment.integration.test.ts` harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books, importLists } from '@db/schema.js';

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

vi.mock('@core/import-lists/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/import-lists/index.js')>();
  return { ...actual, IMPORT_LIST_ADAPTER_FACTORIES: { nyt: vi.fn(), hardcover: vi.fn() } };
});

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('@core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as unknown as Record<string, ReturnType<typeof vi.fn>>;

const TITLE = 'This Inevitable Ruin';
const AUTHOR = 'Matt Dinniman';
/** Real at Audible, absent at Audnexus — the reported failure. */
const DEAD_ASIN = 'B0DK29VYL1';
/** The sibling edition on the same payload that does resolve. */
const LIVE_ASIN = 'B0DK282SYV';

const AUDNEXUS_RECORD = {
  asin: LIVE_ASIN,
  title: TITLE,
  authors: [{ name: AUTHOR }],
  narrators: ['Jeff Hays'],
  duration: 46800,
};

describe('import list falls through a dead primary ASIN to a resolvable alternate — integration (#2611)', () => {
  let e2e: E2EApp;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudibleProvider.searchBooks.mockResolvedValue({ books: [] });
    e2e = await createE2EApp();
  });

  afterEach(async () => {
    await e2e.cleanup();
  });

  /** Seeds a due list whose adapter yields exactly `items`, then runs one real sync. */
  async function syncItems(items: unknown[]) {
    mockFactories.hardcover!.mockReturnValue({
      fetchItems: vi.fn().mockResolvedValue(items),
      test: vi.fn().mockResolvedValue({ success: true }),
    });

    const list = await e2e.services.importList.create({
      name: 'Hardcover Shelf',
      type: 'hardcover',
      settings: { apiKey: 'key', listType: 'shelf', shelfId: 3 },
      syncIntervalMinutes: 1440,
    });
    await e2e.db.update(importLists).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(importLists.id, list.id));

    // `runNow` reports the outcome; `syncDueLists` only logs, which would make a harness fault
    // indistinguishable from an empty sync (see [[import-list-sync-swallows-setup-errors]]).
    const outcome = await e2e.services.importList.runNow(list.id);
    expect(outcome).toMatchObject({ status: 'ok', counts: { createdCount: 1 } });
  }

  const rowFor = async (title: string) => (await e2e.db.select().from(books).where(eq(books.title, title)))[0];

  const reportedItem = {
    title: TITLE, author: AUTHOR, asin: DEAD_ASIN, alternateAsins: [LIVE_ASIN],
  };

  it('persists the resolvable sibling ASIN and its enrichment, not the dead default edition', async () => {
    mockAudnexus.getBook.mockImplementation((asin: string) =>
      Promise.resolve(asin === LIVE_ASIN ? AUDNEXUS_RECORD : null));

    await syncItems([reportedItem]);

    const row = await rowFor(TITLE);
    expect(row).toMatchObject({ asin: LIVE_ASIN, duration: 46800 });
    expect(row!.enrichmentStatus).not.toBe('failed');
    expect(mockAudnexus.getBook.mock.calls.map((call) => call[0])).toEqual([DEAD_ASIN, LIVE_ASIN]);

    const hydrated = await e2e.services.book.getById(row!.id);
    expect(hydrated?.narrators.map((n) => n.name)).toEqual(['Jeff Hays']);
  });

  it('still records the primary ASIN and a failed enrichment when nothing resolves', async () => {
    // Unchanged from today's outcome for this book: the alternates only add probes ahead of the search.
    await syncItems([reportedItem]);

    const row = await rowFor(TITLE);
    expect(row).toMatchObject({ asin: DEAD_ASIN, enrichmentStatus: 'failed' });
    expect(mockAudnexus.getBook.mock.calls.map((call) => call[0])).toEqual([DEAD_ASIN, LIVE_ASIN]);
    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(1);
  });

  it('spends no extra round-trip when the primary ASIN resolves', async () => {
    mockAudnexus.getBook.mockResolvedValue({ ...AUDNEXUS_RECORD, asin: DEAD_ASIN });

    await syncItems([reportedItem]);

    expect(mockAudnexus.getBook.mock.calls.map((call) => call[0])).toEqual([DEAD_ASIN]);
    expect(mockAudibleProvider.searchBooks).not.toHaveBeenCalled();
    expect((await rowFor(TITLE))!.asin).toBe(DEAD_ASIN);
  });
});
