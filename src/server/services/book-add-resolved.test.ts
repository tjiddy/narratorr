import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { RateLimitError, TransientError } from '@core/index.js';
import type { BookMetadata } from '@core/metadata/types.js';
import { addResolvedBook, type ResolvedAddDeps, type ResolvedAddRequest } from './book-add-resolved.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { BookDetail } from './book.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

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

const IMPORT_LIST_PROVENANCE = { source: 'import_list' as const, reason: { importListName: 'My List' }, importListId: 7 };
const ADD_ALL_PROVENANCE = { source: 'manual' as const, reason: { seriesName: 'The Expanse' } };

function makeLog(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>(createMockLogger());
}

function createdBook(overrides: Partial<BookDetail> = {}): BookDetail {
  return { id: 42, title: 'Leviathan Wakes', status: 'wanted', authors: [], narrators: [], ...overrides } as BookDetail;
}

function makeDeps(overrides: Partial<ResolvedAddDeps> = {}): ResolvedAddDeps {
  return {
    bookService: {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
      create: vi.fn().mockResolvedValue(createdBook()),
    },
    recordEvent: vi.fn().mockResolvedValue({ id: 1 }),
    resolver: { resolveBook: vi.fn().mockResolvedValue(MATCH) },
    ...overrides,
  } as ResolvedAddDeps;
}

/** The Series-card shape: a bare title/author/series, pinned. */
function pinnedRequest(overrides: Partial<ResolvedAddRequest> = {}): ResolvedAddRequest {
  return {
    item: { title: 'Leviathan Wakes', author: 'James S. A. Corey', seriesName: 'The Expanse', seriesPosition: 1 },
    identity: 'pin',
    provenance: ADD_ALL_PROVENANCE,
    ...overrides,
  };
}

/** The import-list shape: a shelf item with raw side hints, adopting resolved identity. */
function adoptedRequest(overrides: Partial<ResolvedAddRequest> = {}): ResolvedAddRequest {
  return {
    item: { title: 'Leviathan Wakes', author: 'James S. A. Corey' },
    identity: 'adopt',
    provenance: IMPORT_LIST_PROVENANCE,
    ...overrides,
  };
}

const createPayload = (deps: ResolvedAddDeps) =>
  vi.mocked(deps.bookService.create).mock.calls[0]?.[0] as Record<string, unknown>;

const eventsOfType = (deps: ResolvedAddDeps, eventType: string) =>
  vi.mocked(deps.recordEvent).mock.calls.map(([e]) => e).filter((e) => e.eventType === eventType);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addResolvedBook — create and announce', () => {
  it('creates the resolved row and announces it with the caller\'s provenance', async () => {
    const deps = makeDeps();

    const result = await addResolvedBook(deps, adoptedRequest(), makeLog());

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
    expect(vi.mocked(deps.recordEvent).mock.calls.map(([e]) => e)).toEqual([{
      bookId: 42,
      bookTitle: 'Leviathan Wakes',
      authorName: 'Corey, James S. A.',
      eventType: 'book_added',
      source: 'import_list',
      reason: { importListName: 'My List' },
    }]);
  });

  it('passes the resolved recording evidence to the duplicate check, not title and author alone', async () => {
    const deps = makeDeps();

    await addResolvedBook(deps, pinnedRequest(), makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      asin: 'B_RESOLVED',
      narrators: ['Jefferson Mays'],
      duration: 1290,
      productionType: 'unabridged',
    });
  });

  it('omits authors from the duplicate check when nothing resolved an author', async () => {
    const deps = makeDeps({ resolver: { resolveBook: vi.fn().mockResolvedValue(null) } });

    await addResolvedBook(deps, adoptedRequest({ item: { title: 'Anonymous Book' } }), makeLog());

    expect(vi.mocked(deps.bookService.findDuplicate).mock.calls[0]?.[0]).not.toHaveProperty('authors');
    expect(createPayload(deps)).toMatchObject({ title: 'Anonymous Book', authors: [] });
  });

  it('keeps the member created when the book_added write rejects after the row committed', async () => {
    const log = makeLog();
    const deps = makeDeps({ recordEvent: vi.fn().mockRejectedValue(new Error('events table locked')) });

    const result = await addResolvedBook(deps, pinnedRequest(), log);

    expect(result).toMatchObject({ outcome: 'created' });
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42 }),
      expect.stringContaining('Failed to record book_added event'),
    ));
  });
});

describe('addResolvedBook — dispositions', () => {
  it('returns the incumbent for same-recording, writing no row and no event', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: { id: 77 } as never, hasIncumbent: true,
    });

    const result = await addResolvedBook(deps, pinnedRequest(), makeLog());

    expect(result).toEqual({ outcome: 'same-recording', existingBookId: 77 });
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(deps.recordEvent).not.toHaveBeenCalled();
  });

  it('records recording_review_skipped against the incumbent and carries the reason through', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: { id: 55 } as never, hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
    });

    const result = await addResolvedBook(deps, pinnedRequest(), makeLog());

    expect(result).toEqual({ outcome: 'review', existingBookId: 55, recordingReviewReason: 'narrator-no-signal' });
    expect(deps.recordEvent).toHaveBeenCalledWith({
      bookId: 55,
      bookTitle: 'Leviathan Wakes',
      authorName: 'James S. A. Corey',
      eventType: 'recording_review_skipped',
      source: 'manual',
      reason: { seriesName: 'The Expanse', existingBookId: 55, recordingReviewReason: 'narrator-no-signal' },
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('does not resolve the hold before its event settles, and propagates a rejected one', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: { id: 55 } as never, hasIncumbent: true,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(deps.recordEvent).mockReturnValue(gate.then(() => { throw new Error('events table locked'); }));

    let settled = false;
    const pending = addResolvedBook(deps, pinnedRequest(), makeLog()).catch((e: unknown) => { settled = true; throw e; });

    await vi.waitFor(() => expect(deps.recordEvent).toHaveBeenCalledTimes(1));
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

    const result = await addResolvedBook(deps, pinnedRequest(), makeLog());

    expect(result).toEqual({ outcome: 'owned-race', existingBookId: 31 });
    expect(eventsOfType(deps, 'book_added')).toEqual([]);
  });

  it('propagates any other create failure so the caller can account for it', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(new Error('Failed to find or create author'));

    await expect(addResolvedBook(deps, pinnedRequest(), makeLog())).rejects.toThrow('Failed to find or create author');
  });
});

describe('addResolvedBook — identity policy', () => {
  /** One fixture, two policies: the match disagrees on title, author, series name and position. */
  const item = { title: 'Leviathan Wakes', author: 'James S. A. Corey', seriesName: 'The Expanse', seriesPosition: 1 };

  it('pins the caller\'s four identity fields and adopts only the enrichment fields', async () => {
    const deps = makeDeps();

    await addResolvedBook(deps, { item, identity: 'pin', provenance: ADD_ALL_PROVENANCE }, makeLog());

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

    await addResolvedBook(deps, { item, identity: 'adopt', provenance: IMPORT_LIST_PROVENANCE }, makeLog());

    expect(createPayload(deps)).toMatchObject({
      title: 'Leviathan Wakes: The Expanse Book 1',
      authors: [{ name: 'Corey, James S. A.' }],
      seriesName: 'Expanse (Provider Edition)',
      seriesPosition: 7,
    });
  });

  it('prefers the caller\'s raw cover, description and ISBN hints over the match\'s', async () => {
    const deps = makeDeps();
    const hinted = { ...item, coverUrl: 'https://example.test/raw.jpg', description: 'Raw description', isbn: 'RAW_ISBN' };

    await addResolvedBook(deps, { item: hinted, identity: 'adopt', provenance: IMPORT_LIST_PROVENANCE }, makeLog());

    expect(createPayload(deps)).toMatchObject({
      coverUrl: 'https://example.test/raw.jpg',
      description: 'Raw description',
      isbn: 'RAW_ISBN',
    });
  });

  it('logs a resolved/requested identity disagreement as a warn only when the caller adopts it', async () => {
    const adoptLog = makeLog();
    const pinLog = makeLog();

    await addResolvedBook(makeDeps(), { item, identity: 'adopt', provenance: IMPORT_LIST_PROVENANCE }, adoptLog);
    await addResolvedBook(makeDeps(), { item, identity: 'pin', provenance: ADD_ALL_PROVENANCE }, pinLog);

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

describe('addResolvedBook — provenance', () => {
  it('differs between the two callers only in importListId, source and reason', async () => {
    const importList = makeDeps();
    const addAll = makeDeps();
    const item = { title: 'Leviathan Wakes', author: 'James S. A. Corey' };

    await addResolvedBook(importList, { item, identity: 'adopt', provenance: IMPORT_LIST_PROVENANCE }, makeLog());
    await addResolvedBook(addAll, { item, identity: 'adopt', provenance: ADD_ALL_PROVENANCE }, makeLog());

    const { importListId: listId, ...listRow } = createPayload(importList);
    const { importListId: batchId, ...batchRow } = createPayload(addAll);
    expect(listId).toBe(7);
    expect(batchId).toBeUndefined();
    expect(listRow).toEqual(batchRow);

    expect(vi.mocked(importList.recordEvent).mock.calls[0]?.[0]).toEqual({
      bookId: 42,
      bookTitle: 'Leviathan Wakes',
      authorName: 'Corey, James S. A.',
      eventType: 'book_added',
      source: 'import_list',
      reason: { importListName: 'My List' },
    });
    expect(vi.mocked(addAll.recordEvent).mock.calls[0]?.[0]).toEqual({
      bookId: 42,
      bookTitle: 'Leviathan Wakes',
      authorName: 'Corey, James S. A.',
      eventType: 'book_added',
      source: 'manual',
      reason: { seriesName: 'The Expanse' },
    });
  });
});

describe('addResolvedBook — resolution failures', () => {
  it('creates the raw row and never calls a resolver when none is configured', async () => {
    const deps = makeDeps({ resolver: undefined });
    const item = { title: 'Raw Title', author: 'Raw Author', asin: 'B_RAW', isbn: 'RAW_ISBN', coverUrl: 'https://example.test/raw.jpg', description: 'Raw', seriesName: 'Raw Series', seriesPosition: 3 };

    await addResolvedBook(deps, { item, identity: 'adopt', provenance: IMPORT_LIST_PROVENANCE }, makeLog());

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

    await addResolvedBook(deps, pinnedRequest(), makeLog());

    expect(createPayload(deps)).toMatchObject({ title: 'Leviathan Wakes', seriesName: 'The Expanse', enrichmentStatus: 'failed' });
  });

  it.each([
    ['a rate limit', new RateLimitError(30_000, 'Audible.com'), 'rate limited'],
    ['a transient provider error', new TransientError('Audible.com', 'HTTP 503'), 'transient provider error'],
    ['an unclassified error', new Error('Network error'), 'Metadata enrichment failed'],
  ])('leaves the row pending, not failed, after %s', async (_label, error, message) => {
    const log = makeLog();
    const deps = makeDeps({ resolver: { resolveBook: vi.fn().mockRejectedValue(error) } });

    const result = await addResolvedBook(deps, pinnedRequest(), log);

    expect(result).toMatchObject({ outcome: 'created' });
    expect(createPayload(deps)).toMatchObject({ title: 'Leviathan Wakes' });
    expect(createPayload(deps).enrichmentStatus).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leviathan Wakes' }), expect.stringContaining(message));
  });

  it('resolves an authorless item with author undefined, never null or empty', async () => {
    const deps = makeDeps();

    await addResolvedBook(deps, pinnedRequest({ item: { title: 'Solo Title', seriesName: 'The Expanse', seriesPosition: 4 } }), makeLog());

    expect(deps.resolver?.resolveBook).toHaveBeenCalledWith({ asin: undefined, title: 'Solo Title', author: undefined });
  });
});
