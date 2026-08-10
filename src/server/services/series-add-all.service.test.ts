import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('./search-pipeline.js', () => ({
  searchAndGrabForBook: vi.fn().mockResolvedValue(undefined),
  buildNarratorPriority: vi.fn().mockReturnValue([]),
  buildSearchFilterOptions: vi.fn().mockReturnValue({}),
}));

import { SeriesAddAllService, type SeriesAddAllDeps } from './series-add-all.service.js';
import { searchAndGrabForBook } from './search-pipeline.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { BookSeriesCardData, BookSeriesMemberCard } from './series-card.service.js';
import type { BookDetail } from './book.service.js';

function member(overrides: Partial<BookSeriesMemberCard> & { title: string }): BookSeriesMemberCard {
  return {
    hardcoverBookId: null, slug: null, position: 1, imageUrl: null,
    inLibrary: false, libraryBookId: null, ...overrides,
  };
}

function card(overrides: Partial<BookSeriesCardData> = {}): BookSeriesCardData {
  return {
    id: 500,
    name: 'The Expanse',
    hardcoverSeriesId: 900,
    seriesAuthor: 'James S. A. Corey',
    lastFetchedAt: null,
    members: [member({ title: 'Leviathan Wakes', position: 1 })],
    ...overrides,
  };
}

function makeLog(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
}

let nextBookId = 1;
function createdBook(title: string): BookDetail {
  return { id: nextBookId++, title, status: 'wanted', authors: [], narrators: [] } as unknown as BookDetail;
}

function makeDeps(overrides: Partial<SeriesAddAllDeps> = {}): SeriesAddAllDeps {
  return {
    bookService: {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
      create: vi.fn().mockImplementation((input: { title: string }) => Promise.resolve(createdBook(input.title))),
      getById: vi.fn().mockResolvedValue(null),
    },
    eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(card()) },
    search: {
      indexerSearchService: {} as never,
      indexerService: {} as never,
      downloadOrchestrator: {} as never,
      settingsService: { get: vi.fn().mockResolvedValue({}) } as never,
      blacklistService: {} as never,
      eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) } as never,
      eventBroadcaster: {} as never,
    },
    ...overrides,
  } as SeriesAddAllDeps;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function run(deps: SeriesAddAllDeps, bookId = 1, searchImmediately = false) {
  const result = await new SeriesAddAllService(deps).addAll(bookId, { searchImmediately }, makeLog());
  if (result.outcome !== 'ok') throw new Error(`expected ok, got ${result.outcome}`);
  return result.response;
}

beforeEach(() => {
  vi.clearAllMocks();
  nextBookId = 1;
});

describe('SeriesAddAllService — selection', () => {
  it('creates a row only for unowned major members, carrying series name, position and author', async () => {
    const deps = makeDeps({
      seriesCardService: {
        getSeriesForBook: vi.fn().mockResolvedValue(card({
          members: [
            member({ title: 'Leviathan Wakes', position: 1 }),
            member({ title: 'Gods of Risk', position: 0.1 }),
            member({ title: "Caliban's War", position: 2 }),
            member({ title: 'Abaddons Gate', position: 3, inLibrary: true, libraryBookId: 88 }),
            member({ title: '   ', position: 4 }),
            member({ title: 'Unplaced', position: null }),
            member({ title: 'Prequel', position: 0 }),
            member({ title: 'Negative', position: -1 }),
          ],
        })),
      },
    });

    const response = await run(deps);

    expect(vi.mocked(deps.bookService.create).mock.calls.map(([input]) => input)).toEqual([
      { title: 'Leviathan Wakes', authors: [{ name: 'James S. A. Corey' }], seriesName: 'The Expanse', seriesPosition: 1 },
      { title: "Caliban's War", authors: [{ name: 'James S. A. Corey' }], seriesName: 'The Expanse', seriesPosition: 2 },
    ]);
    expect(response.requested).toBe(2);
    expect(response.members.map((m) => m.title)).toEqual(['Leviathan Wakes', "Caliban's War"]);
  });

  it('creates the trimmed title for a padded member', async () => {
    const deps = makeDeps({
      seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(card({ members: [member({ title: '  Padded  ' })] })) },
    });

    const response = await run(deps);

    expect(vi.mocked(deps.bookService.create).mock.calls[0]?.[0]).toMatchObject({ title: 'Padded' });
    expect(response.members[0]?.title).toBe('Padded');
  });

  it('creates rows with no authors when the series has no author', async () => {
    const deps = makeDeps({
      seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(card({ seriesAuthor: null })) },
    });

    await run(deps);

    expect(vi.mocked(deps.bookService.create).mock.calls[0]?.[0]).toMatchObject({ authors: [] });
  });

  it('sets neither an ASIN nor an enrichment status so the row defaults to pending', async () => {
    const deps = makeDeps();
    await run(deps);

    const input = vi.mocked(deps.bookService.create).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty('asin');
    expect(input).not.toHaveProperty('enrichmentStatus');
  });

  it('returns a zeroed batch and writes nothing when the book has no series card', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(null) } });

    const response = await run(deps);

    expect(response).toEqual({ requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('returns a zeroed batch for a library-only card, which has no series id to key a guard on', async () => {
    const deps = makeDeps({
      seriesCardService: {
        getSeriesForBook: vi.fn().mockResolvedValue(card({
          id: null,
          hardcoverSeriesId: null,
          members: [member({ title: 'Owned One', position: 1, inLibrary: true, libraryBookId: 4 })],
        })),
      },
    });

    const response = await run(deps);

    expect(response).toEqual({ requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });
});

describe('SeriesAddAllService — dispositions', () => {
  const twoMembers = card({
    members: [member({ title: 'One', position: 1 }), member({ title: 'Two', position: 2 })],
  });

  it('reports same-recording as owned, with the incumbent id and no row', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: { id: 77 } as BookDetail, hasIncumbent: true,
    });

    const response = await run(deps);

    expect(response).toMatchObject({ requested: 1, created: 0, owned: 1, held: 0, failed: 0 });
    expect(response.members[0]).toEqual({ title: 'Leviathan Wakes', position: 1, disposition: 'owned', bookId: 77 });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('reports a create-time ASIN race as owned and continues the batch', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(twoMembers) } });
    vi.mocked(deps.bookService.create)
      .mockRejectedValueOnce(new OwnedRecordingError({ existingBookId: 31, title: 'One', reason: 'asin-owned' }))
      .mockImplementationOnce((input: { title: string }) => Promise.resolve(createdBook(input.title)));
    vi.mocked(deps.bookService.getById).mockResolvedValue({ id: 31 } as BookDetail);

    const response = await run(deps);

    expect(response).toMatchObject({ requested: 2, created: 1, owned: 1, failed: 0 });
    expect(response.members[0]).toMatchObject({ title: 'One', disposition: 'owned', bookId: 31 });
    expect(response.members[1]).toMatchObject({ title: 'Two', disposition: 'created' });
  });

  it('writes a recording_review_skipped event against the incumbent for a review verdict', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: { id: 55 } as BookDetail, hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
    });

    const response = await run(deps);

    expect(response).toMatchObject({ requested: 1, created: 0, owned: 0, held: 1, failed: 0 });
    expect(response.members[0]).toEqual({ title: 'Leviathan Wakes', position: 1, disposition: 'held', bookId: 55 });
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

  it('reports held only after the review event settles, never on mere issuance', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: { id: 55 } as BookDetail, hasIncumbent: true,
    });
    const eventWrite = deferred<{ id: number }>();
    vi.mocked(deps.eventHistory.create).mockReturnValue(eventWrite.promise as never);

    let settled = false;
    const pending = run(deps).then((r) => { settled = true; return r; });

    await vi.waitFor(() => expect(deps.eventHistory.create).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);

    eventWrite.resolve({ id: 1 });
    expect((await pending).held).toBe(1);
  });

  it('reports failed — not held — when the review event write rejects, and continues the batch', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(twoMembers) } });
    vi.mocked(deps.bookService.findDuplicate)
      .mockResolvedValueOnce({ verdict: 'review', book: { id: 55 } as BookDetail, hasIncumbent: true })
      .mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false });
    vi.mocked(deps.eventHistory.create).mockRejectedValueOnce(new Error('events table locked'));

    const response = await run(deps);

    expect(response).toMatchObject({ requested: 2, created: 1, owned: 0, held: 0, failed: 1 });
    expect(response.members[0]).toEqual({ title: 'One', position: 1, disposition: 'failed', bookId: null });
    expect(response.members[1]).toMatchObject({ title: 'Two', disposition: 'created' });
  });

  it('keeps a member created when its book_added write rejects after the row committed', async () => {
    const deps = makeDeps();
    vi.mocked(deps.eventHistory.create).mockRejectedValue(new Error('events table locked'));

    const response = await run(deps, 1, true);

    expect(response).toMatchObject({ requested: 1, created: 1, failed: 0 });
    expect(response.members[0]).toMatchObject({ disposition: 'created', bookId: 1 });
    // Still enqueued for its immediate search despite the rejected bookkeeping write.
    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(1));
  });

  it('isolates a pre-create failure as failed with no row and no durable account', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(twoMembers) } });
    vi.mocked(deps.bookService.findDuplicate)
      .mockRejectedValueOnce(new Error('dedup exploded'))
      .mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false });

    const response = await run(deps);

    expect(response).toMatchObject({ requested: 2, created: 1, failed: 1 });
    expect(response.members[0]).toEqual({ title: 'One', position: 1, disposition: 'failed', bookId: null });
    expect(vi.mocked(deps.bookService.create).mock.calls.map(([i]) => (i as { title: string }).title)).toEqual(['Two']);
  });

  it('accounts for every selected member exactly once on a mixed run', async () => {
    const deps = makeDeps({
      seriesCardService: {
        getSeriesForBook: vi.fn().mockResolvedValue(card({
          members: [1, 2, 3, 4].map((position) => member({ title: `Book ${position}`, position })),
        })),
      },
    });
    vi.mocked(deps.bookService.findDuplicate)
      .mockResolvedValueOnce({ verdict: 'different-recording', book: null, hasIncumbent: false })
      .mockResolvedValueOnce({ verdict: 'same-recording', book: { id: 21 } as BookDetail, hasIncumbent: true })
      .mockResolvedValueOnce({ verdict: 'review', book: { id: 22 } as BookDetail, hasIncumbent: true })
      .mockRejectedValueOnce(new Error('boom'));

    const response = await run(deps);

    expect(response).toMatchObject({ requested: 4, created: 1, owned: 1, held: 1, failed: 1 });
    expect(response.created + response.owned + response.held + response.failed).toBe(response.requested);
    expect(response.members).toHaveLength(response.requested);
    expect(response.members.map((m) => m.disposition)).toEqual(['created', 'owned', 'held', 'failed']);
  });

  it('creates rows one at a time so overlapping transactions cannot contend', async () => {
    const deps = makeDeps({
      seriesCardService: {
        getSeriesForBook: vi.fn().mockResolvedValue(card({
          members: [1, 2, 3].map((position) => member({ title: `Book ${position}`, position })),
        })),
      },
    });
    let concurrent = 0;
    let peak = 0;
    vi.mocked(deps.bookService.create).mockImplementation(async (input: { title: string }) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 1));
      concurrent -= 1;
      return createdBook(input.title);
    });

    await run(deps);

    expect(peak).toBe(1);
  });
});

describe('SeriesAddAllService — immediate search fan-out', () => {
  const threeMembers = card({
    members: [1, 2, 3].map((position) => member({ title: `Book ${position}`, position })),
  });

  it('searches every created book and no owned, held or failed member', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(threeMembers) } });
    vi.mocked(deps.bookService.findDuplicate)
      .mockResolvedValueOnce({ verdict: 'different-recording', book: null, hasIncumbent: false })
      .mockResolvedValueOnce({ verdict: 'same-recording', book: { id: 21 } as BookDetail, hasIncumbent: true })
      .mockResolvedValueOnce({ verdict: 'review', book: { id: 22 } as BookDetail, hasIncumbent: true });

    await run(deps, 1, true);

    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(searchAndGrabForBook).mock.calls.map(([book]) => (book as { title: string }).title)).toEqual(['Book 1']);
  });

  it('searches nothing when searchImmediately is false', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(threeMembers) } });

    await run(deps, 1, false);
    await new Promise((r) => setTimeout(r, 20));

    expect(searchAndGrabForBook).not.toHaveBeenCalled();
  });

  it('lets each search settle before starting the next', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(threeMembers) } });
    const gates = [deferred(), deferred(), deferred()];
    const settled: string[] = [];
    vi.mocked(searchAndGrabForBook).mockImplementation(async (book: unknown) => {
      const title = (book as { title: string }).title;
      const index = Number(title.split(' ')[1]) - 1;
      await gates[index]!.promise;
      settled.push(title);
      return undefined as never;
    });

    await run(deps, 1, true);

    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(1));
    // The second search must not have been issued while the first is unsettled.
    expect(searchAndGrabForBook).toHaveBeenCalledTimes(1);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(2));
    gates[1]!.resolve();
    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(3));
    gates[2]!.resolve();
    await vi.waitFor(() => expect(settled).toEqual(['Book 1', 'Book 2', 'Book 3']));
  });

  it('continues the chain after one book\'s search rejects', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(threeMembers) } });
    vi.mocked(searchAndGrabForBook)
      .mockRejectedValueOnce(new Error('indexer down'))
      .mockResolvedValue(undefined as never);

    await run(deps, 1, true);

    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(3));
  });

  it('returns the response without waiting for the searches', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(threeMembers) } });
    const gate = deferred();
    vi.mocked(searchAndGrabForBook).mockImplementation(() => gate.promise as never);

    const response = await run(deps, 1, true);

    expect(response.created).toBe(3);
    await vi.waitFor(() => expect(searchAndGrabForBook).toHaveBeenCalledTimes(1));
    gate.resolve();
  });
});

describe('SeriesAddAllService — admission guard', () => {
  const twoMembers = card({
    members: [member({ title: 'One', position: 1 }), member({ title: 'Two', position: 2 })],
  });

  it('refuses a second batch for the same series while one is in flight', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(twoMembers) } });
    const gate = deferred<BookDetail>();
    vi.mocked(deps.bookService.create).mockReturnValueOnce(gate.promise as never);
    const service = new SeriesAddAllService(deps);

    const first = service.addAll(1, { searchImmediately: false }, makeLog());
    await vi.waitFor(() => expect(deps.bookService.create).toHaveBeenCalledTimes(1));

    const second = await service.addAll(1, { searchImmediately: false }, makeLog());

    expect(second).toEqual({ outcome: 'in-flight' });
    expect(deps.bookService.create).toHaveBeenCalledTimes(1);

    gate.resolve(createdBook('One'));
    await first;
  });

  it('contends on the series id, so a sibling book of the same series is refused too', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(twoMembers) } });
    const gate = deferred<BookDetail>();
    vi.mocked(deps.bookService.create).mockReturnValueOnce(gate.promise as never);
    const service = new SeriesAddAllService(deps);

    const first = service.addAll(1, { searchImmediately: false }, makeLog());
    await vi.waitFor(() => expect(deps.bookService.create).toHaveBeenCalledTimes(1));

    // A different book id whose card resolves to the same series row.
    expect(await service.addAll(2, { searchImmediately: false }, makeLog())).toEqual({ outcome: 'in-flight' });

    gate.resolve(createdBook('One'));
    await first;
  });

  it('does not make two different series contend', async () => {
    const other = card({ id: 501, name: 'Mistborn', members: [member({ title: 'The Final Empire', position: 1 })] });
    const getSeriesForBook = vi.fn().mockImplementation((id: number) => Promise.resolve(id === 1 ? twoMembers : other));
    const deps = makeDeps({ seriesCardService: { getSeriesForBook } });
    const gate = deferred<BookDetail>();
    vi.mocked(deps.bookService.create).mockReturnValueOnce(gate.promise as never);
    const service = new SeriesAddAllService(deps);

    const first = service.addAll(1, { searchImmediately: false }, makeLog());
    await vi.waitFor(() => expect(deps.bookService.create).toHaveBeenCalledTimes(1));

    const second = await service.addAll(2, { searchImmediately: false }, makeLog());

    expect(second).toMatchObject({ outcome: 'ok', response: { created: 1 } });

    gate.resolve(createdBook('One'));
    await first;
  });

  it('releases the guard when the batch throws, so the series is not permanently refused', async () => {
    const deps = makeDeps({ seriesCardService: { getSeriesForBook: vi.fn().mockResolvedValue(twoMembers) } });
    const service = new SeriesAddAllService(deps);
    vi.mocked(deps.seriesCardService.getSeriesForBook)
      .mockResolvedValueOnce(twoMembers)
      .mockRejectedValueOnce(new Error('card read exploded'));

    await expect(service.addAll(1, { searchImmediately: false }, makeLog())).rejects.toThrow('card read exploded');

    vi.mocked(deps.seriesCardService.getSeriesForBook).mockResolvedValue(twoMembers);
    const retry = await service.addAll(1, { searchImmediately: false }, makeLog());
    expect(retry).toMatchObject({ outcome: 'ok', response: { created: 2 } });
  });

  it('reads the authoritative member selection inside the guard', async () => {
    const stale = card({ members: [member({ title: 'One', position: 1 }), member({ title: 'Two', position: 2 })] });
    const fresh = card({
      members: [member({ title: 'One', position: 1, inLibrary: true, libraryBookId: 9 }), member({ title: 'Two', position: 2 })],
    });
    const getSeriesForBook = vi.fn().mockResolvedValueOnce(stale).mockResolvedValue(fresh);
    const deps = makeDeps({ seriesCardService: { getSeriesForBook } });

    const response = await run(deps);

    expect(getSeriesForBook).toHaveBeenCalledTimes(2);
    expect(response.requested).toBe(1);
    expect(response.members.map((m) => m.title)).toEqual(['Two']);
  });
});
