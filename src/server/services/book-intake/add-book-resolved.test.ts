import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { RateLimitError, TransientError } from '@core/index.js';
import type { BookMetadata } from '@core/metadata/types.js';
import { addBook } from './index.js';
import type { AddBookDeps, AddBookEvent, AddBookRequest, AddBookSeed } from './index.js';
import { OwnedRecordingError } from '../book-dedup.js';
import type { BookDetail } from '../book.service.js';
import { createMockLogger, inject } from '../../__tests__/helpers.js';

/**
 * The `resolve: 'required'` arm — the pipeline the two bulk add surfaces run. Migrated from
 * `book-add-resolved.test.ts` when #2246 folded `addResolvedBook` into `addBook`; every behaviour
 * assertion survives, and the call shapes moved onto the `seed`/`identity` request arm.
 */

/**
 * The resolved match every fixture starts from: it disagrees with the caller's identity on all four
 * identity fields at once, so one input proves both policies.
 */
const MATCH: BookMetadata = {
  asin: 'B_RESOLVED',
  title: 'Leviathan Wakes: The Expanse Book 1',
  authors: [{ name: 'Corey, James S. A.' }],
  narrators: ['Jefferson Mays'],
  // books.duration is MINUTES; 1290 is 21h30m, not 21 seconds.
  duration: 1290,
  subtitle: 'The Expanse, Book 1',
  description: 'Resolved description',
  publisher: 'Orbit',
  coverUrl: 'https://example.test/cover.jpg',
  publishedDate: '2011-06-15',
  genres: ['Science Fiction'],
  seriesPrimary: { name: 'Expanse (Provider Edition)', position: 7 },
  formatType: 'unabridged',
  isbn: '9780316129084',
};

const IMPORT_LIST_PROVENANCE = {
  source: 'import_list' as const, reason: { importListName: 'My List' }, eventShape: 'resolved' as const, importListId: 7,
};
const ADD_ALL_PROVENANCE = {
  source: 'manual' as const, reason: { seriesName: 'The Expanse' }, eventShape: 'resolved' as const,
};

function makeLog(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>(createMockLogger());
}

function createdBook(overrides: Partial<BookDetail> = {}): BookDetail {
  return { id: 42, title: 'Leviathan Wakes', status: 'wanted', authors: [], narrators: [], ...overrides } as BookDetail;
}

function makeDeps(overrides: Partial<AddBookDeps> = {}): AddBookDeps {
  return {
    bookService: {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
      create: vi.fn().mockResolvedValue(createdBook()),
      getById: vi.fn().mockResolvedValue(null),
    },
    eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    resolver: { resolveBook: vi.fn().mockResolvedValue(MATCH) },
    ...overrides,
  } as AddBookDeps;
}

/** The Series-card shape: a bare title/author/series, pinned, holding its review on the incumbent. */
function pinnedRequest(seedOverride?: AddBookSeed): AddBookRequest {
  return {
    resolve: 'required',
    seed: seedOverride ?? { title: 'Leviathan Wakes', author: 'James S. A. Corey', seriesName: 'The Expanse', seriesPosition: 1 },
    identity: 'pin',
    onReview: 'record-and-hold',
    provenance: ADD_ALL_PROVENANCE,
  };
}

/** The import-list shape: a shelf item with raw side hints, adopting resolved identity. */
function adoptedRequest(seedOverride?: AddBookSeed): AddBookRequest {
  return {
    resolve: 'required',
    seed: seedOverride ?? { title: 'Leviathan Wakes', author: 'James S. A. Corey' },
    identity: 'adopt',
    onReview: 'record-and-hold',
    provenance: IMPORT_LIST_PROVENANCE,
  };
}

const createPayload = (deps: AddBookDeps) =>
  vi.mocked(deps.bookService.create).mock.calls[0]?.[0] as unknown as Record<string, unknown>;

const events = (deps: AddBookDeps): AddBookEvent[] =>
  vi.mocked(deps.eventHistory.create).mock.calls.map(([e]) => e);

const eventsOfType = (deps: AddBookDeps, eventType: string) =>
  events(deps).filter((e) => e.eventType === eventType);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addBook (resolve: required) — create and announce', () => {
  it('creates the resolved row and announces it with the caller\'s provenance', async () => {
    const deps = makeDeps();

    const result = await addBook(deps, adoptedRequest(), makeLog());

    // authorName is the resolved primary author, which the caller's own search trigger needs.
    expect(result).toEqual({ outcome: 'created', book: createdBook(), authorName: 'Corey, James S. A.' });
    expect(createPayload(deps)).toEqual({
      title: 'Leviathan Wakes: The Expanse Book 1',
      authors: [{ name: 'Corey, James S. A.' }],
      narrators: ['Jefferson Mays'],
      subtitle: 'The Expanse, Book 1',
      description: 'Resolved description',
      publisher: 'Orbit',
      coverUrl: 'https://example.test/cover.jpg',
      asin: 'B_RESOLVED',
      isbn: '9780316129084',
      seriesName: 'Expanse (Provider Edition)',
      seriesPosition: 7,
      duration: 1290,
      publishedDate: '2011-06-15',
      genres: ['Science Fiction'],
      productionType: 'unabridged',
      status: 'wanted',
      importListId: 7,
    });
    expect(createPayload(deps).enrichmentStatus).toBeUndefined();
    expect(events(deps)).toEqual([{
      bookId: 42,
      bookTitle: 'Leviathan Wakes',
      authorName: 'Corey, James S. A.',
      eventType: 'book_added',
      source: 'import_list',
      reason: { importListName: 'My List' },
    }]);
  });

  // AC6: `toEqual` and `expect.not.objectContaining` both pass for a present-but-undefined key, so
  // the absence of the snapshot shape's narrator field is asserted on the captured argument (#2245).
  it('writes no narratorName key at all on the resolved book_added payload', async () => {
    const deps = makeDeps();

    await addBook(deps, adoptedRequest(), makeLog());

    expect(events(deps)[0]).not.toHaveProperty('narratorName');
  });

  it('passes the resolved recording evidence to the duplicate check, not title and author alone', async () => {
    const deps = makeDeps();

    await addBook(deps, pinnedRequest(), makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      asin: 'B_RESOLVED',
      narrators: ['Jefferson Mays'],
      duration: 1290,
      productionType: 'unabridged',
    });
  });

  // The pre-port ladder omitted the key; the shared derivation forwards the empty list the create
  // payload carries. `gatherIncumbentIds` and `toRecordingCandidate` read the two identically.
  it('carries no author name into the duplicate check when nothing resolved an author', async () => {
    const deps = makeDeps({ resolver: { resolveBook: vi.fn().mockResolvedValue(null) } });

    await addBook(deps, adoptedRequest({ title: 'Anonymous Book' }), makeLog());

    expect(vi.mocked(deps.bookService.findDuplicate).mock.calls[0]?.[0].authors).toEqual([]);
    expect(createPayload(deps)).toMatchObject({ title: 'Anonymous Book', authors: [] });
  });

  it('keeps the member created when the book_added write rejects after the row committed', async () => {
    const log = makeLog();
    const deps = makeDeps({ eventHistory: { create: vi.fn().mockRejectedValue(new Error('events table locked')) } });

    const result = await addBook(deps, pinnedRequest(), log);

    expect(result).toMatchObject({ outcome: 'created' });
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42 }),
      expect.stringContaining('Failed to record book_added event'),
    ));
  });
});

describe('addBook (resolve: required) — dispositions', () => {
  it('returns the incumbent for same-recording, writing no row and no event', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: { id: 77 } as never, hasIncumbent: true,
    });

    const result = await addBook(deps, pinnedRequest(), makeLog());

    expect(result).toEqual({
      outcome: 'duplicate', verdict: 'same-recording', book: { id: 77 }, existingBookId: 77,
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('records recording_review_skipped against the incumbent and carries the reason through', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: { id: 55 } as never, hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
    });

    const result = await addBook(deps, pinnedRequest(), makeLog());

    expect(result).toEqual({
      outcome: 'duplicate',
      verdict: 'review',
      book: { id: 55 },
      existingBookId: 55,
      recordingReviewReason: 'narrator-no-signal',
    });
    expect(deps.eventHistory.create).toHaveBeenCalledWith({
      bookId: 55,
      bookTitle: 'Leviathan Wakes',
      authorName: 'James S. A. Corey',
      eventType: 'recording_review_skipped',
      source: 'manual',
      reason: { seriesName: 'The Expanse', existingBookId: 55, recordingReviewReason: 'narrator-no-signal' },
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  // Production's resolver always hands a review/same-recording verdict its representative row, but
  // the union admits null and the bulk callers report a bare id — so it must degrade, not admit.
  it.each(['same-recording', 'review'] as const)(
    'reports a %s verdict carrying no representative book with a null incumbent id',
    async (verdict) => {
      const deps = makeDeps();
      vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({ verdict, book: null, hasIncumbent: true });

      const result = await addBook(deps, pinnedRequest(), makeLog());

      expect(result).toMatchObject({ outcome: 'duplicate', verdict, book: null, existingBookId: null });
      expect(deps.bookService.create).not.toHaveBeenCalled();
    },
  );

  it('does not resolve the hold before its event settles, and propagates a rejected one', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: { id: 55 } as never, hasIncumbent: true,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(deps.eventHistory.create).mockReturnValue(gate.then(() => { throw new Error('events table locked'); }));

    let settled = false;
    const pending = addBook(deps, pinnedRequest(), makeLog()).catch((e: unknown) => { settled = true; throw e; });

    await vi.waitFor(() => expect(deps.eventHistory.create).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(pending).rejects.toThrow('events table locked');
  });

  it('reports a create-time ASIN race as owned-race instead of throwing', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(
      new OwnedRecordingError({ existingBookId: 31, title: 'Leviathan Wakes', reason: 'asin-owned' }),
    );

    const result = await addBook(deps, pinnedRequest(), makeLog());

    expect(result).toMatchObject({ outcome: 'owned-race', existingBookId: 31 });
    expect(eventsOfType(deps, 'book_added')).toEqual([]);
  });

  // AC12: the widened `getById` dep runs on the bulk path too, and a rejection there must not turn
  // a committed collision into a batch-aborting throw.
  it('still reports owned-race when the incumbent hydration rejects', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(
      new OwnedRecordingError({ existingBookId: 31, title: 'Leviathan Wakes', reason: 'asin-owned' }),
    );
    vi.mocked(deps.bookService.getById).mockRejectedValue(new Error('db handle closed'));

    const result = await addBook(deps, pinnedRequest(), makeLog());

    expect(result).toMatchObject({ outcome: 'owned-race', existingBookId: 31, book: null });
  });

  it('propagates any other create failure so the caller can account for it', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(new Error('Failed to find or create author'));

    await expect(addBook(deps, pinnedRequest(), makeLog())).rejects.toThrow('Failed to find or create author');
  });
});

describe('addBook (resolve: required) — identity policy', () => {
  /** One fixture, two policies: the match disagrees on title, author, series name and position. */
  const seed = { title: 'Leviathan Wakes', author: 'James S. A. Corey', seriesName: 'The Expanse', seriesPosition: 1 };

  it('pins the caller\'s four identity fields and adopts only the enrichment fields', async () => {
    const deps = makeDeps();

    await addBook(deps, pinnedRequest(seed), makeLog());

    expect(createPayload(deps)).toMatchObject({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      seriesName: 'The Expanse',
      seriesPosition: 1,
      // Everything that is not identity still comes from the match.
      coverUrl: 'https://example.test/cover.jpg',
      narrators: ['Jefferson Mays'],
      duration: 1290,
      asin: 'B_RESOLVED',
      subtitle: 'The Expanse, Book 1',
      description: 'Resolved description',
      publisher: 'Orbit',
      genres: ['Science Fiction'],
      publishedDate: '2011-06-15',
      productionType: 'unabridged',
    });
  });

  it('adopts the resolved identity under the adopt policy, from the same input', async () => {
    const deps = makeDeps();

    await addBook(deps, adoptedRequest(seed), makeLog());

    expect(createPayload(deps)).toMatchObject({
      title: 'Leviathan Wakes: The Expanse Book 1',
      authors: [{ name: 'Corey, James S. A.' }],
      seriesName: 'Expanse (Provider Edition)',
      seriesPosition: 7,
    });
  });

  it('prefers the caller\'s raw cover, description and ISBN hints over the match\'s', async () => {
    const deps = makeDeps();
    const hinted = { ...seed, coverUrl: 'https://example.test/raw.jpg', description: 'Raw description', isbn: 'RAW_ISBN' };

    await addBook(deps, adoptedRequest(hinted), makeLog());

    expect(createPayload(deps)).toMatchObject({
      coverUrl: 'https://example.test/raw.jpg',
      description: 'Raw description',
      isbn: 'RAW_ISBN',
    });
  });

  it('logs a resolved/requested identity disagreement as a warn only when the caller adopts it', async () => {
    const adoptLog = makeLog();
    const pinLog = makeLog();

    await addBook(makeDeps(), adoptedRequest(seed), adoptLog);
    await addBook(makeDeps(), pinnedRequest(seed), pinLog);

    expect(adoptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ listTitle: 'Leviathan Wakes', metadataTitle: MATCH.title, metadataAuthor: 'Corey, James S. A.' }),
      expect.stringContaining('adopting resolved metadata'),
    );
    expect(pinLog.warn).not.toHaveBeenCalled();
    expect(pinLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({ metadataTitle: MATCH.title }),
      expect.stringContaining('pinning the caller identity'),
    );
  });
});

describe('addBook (resolve: required) — provenance', () => {
  it('differs between the two callers only in importListId, source and reason', async () => {
    const importList = makeDeps();
    const addAll = makeDeps();
    const seed = { title: 'Leviathan Wakes', author: 'James S. A. Corey' };

    await addBook(importList, adoptedRequest(seed), makeLog());
    await addBook(addAll, { ...adoptedRequest(seed), provenance: ADD_ALL_PROVENANCE }, makeLog());

    const { importListId: listId, ...listRow } = createPayload(importList);
    const { importListId: batchId, ...batchRow } = createPayload(addAll);
    expect(listId).toBe(7);
    expect(batchId).toBeUndefined();
    expect(listRow).toEqual(batchRow);

    expect(events(importList)[0]).toEqual({
      bookId: 42,
      bookTitle: 'Leviathan Wakes',
      authorName: 'Corey, James S. A.',
      eventType: 'book_added',
      source: 'import_list',
      reason: { importListName: 'My List' },
    });
    expect(events(addAll)[0]).toEqual({
      bookId: 42,
      bookTitle: 'Leviathan Wakes',
      authorName: 'Corey, James S. A.',
      eventType: 'book_added',
      source: 'manual',
      reason: { seriesName: 'The Expanse' },
    });
  });
});

describe('addBook (resolve: required) — resolution failures', () => {
  it('creates the raw row and never calls a resolver when none is configured', async () => {
    const deps = makeDeps({ resolver: undefined });
    const seed = { title: 'Raw Title', author: 'Raw Author', asin: 'B_RAW', isbn: 'RAW_ISBN', coverUrl: 'https://example.test/raw.jpg', description: 'Raw', seriesName: 'Raw Series', seriesPosition: 3 };

    await addBook(deps, adoptedRequest(seed), makeLog());

    expect(createPayload(deps)).toEqual({
      title: 'Raw Title',
      authors: [{ name: 'Raw Author' }],
      asin: 'B_RAW',
      isbn: 'RAW_ISBN',
      coverUrl: 'https://example.test/raw.jpg',
      description: 'Raw',
      seriesName: 'Raw Series',
      seriesPosition: 3,
      status: 'wanted',
      importListId: 7,
    });
    expect(createPayload(deps).enrichmentStatus).toBeUndefined();
  });

  it('marks a genuine no-match failed so the retry window applies', async () => {
    const deps = makeDeps({ resolver: { resolveBook: vi.fn().mockResolvedValue(null) } });

    await addBook(deps, pinnedRequest(), makeLog());

    expect(createPayload(deps)).toMatchObject({ title: 'Leviathan Wakes', seriesName: 'The Expanse', enrichmentStatus: 'failed' });
  });

  it.each([
    ['a rate limit', new RateLimitError(30_000, 'Audible.com'), 'rate limited'],
    ['a transient provider error', new TransientError('Audible.com', 'HTTP 503'), 'transient provider error'],
    ['an unclassified error', new Error('Network error'), 'Metadata enrichment failed'],
  ])('leaves the row pending, not failed, after %s', async (_label, error, message) => {
    const log = makeLog();
    const deps = makeDeps({ resolver: { resolveBook: vi.fn().mockRejectedValue(error) } });

    const result = await addBook(deps, pinnedRequest(), log);

    expect(result).toMatchObject({ outcome: 'created' });
    expect(createPayload(deps)).toMatchObject({ title: 'Leviathan Wakes' });
    // AC7's discriminator: not merely `undefined` — the key is absent, so the create primitive's
    // own default stands and the row is pending rather than failed.
    expect(createPayload(deps)).not.toHaveProperty('enrichmentStatus');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leviathan Wakes' }), expect.stringContaining(message));
  });

  it('resolves an authorless item with author undefined, never null or empty', async () => {
    const deps = makeDeps();

    await addBook(deps, pinnedRequest({ title: 'Solo Title', seriesName: 'The Expanse', seriesPosition: 4 }), makeLog());

    expect(deps.resolver?.resolveBook).toHaveBeenCalledWith({ asin: undefined, title: 'Solo Title', author: undefined });
    expect(createPayload(deps)).toMatchObject({ authors: [] });
  });
});
