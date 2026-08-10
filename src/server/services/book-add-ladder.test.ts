import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { addBookThroughLadder, type AddBookLadderDeps } from './book-add-ladder.js';
import { OwnedRecordingError } from './book-dedup.js';
import type { BookDetail } from './book.service.js';

function makeBook(overrides: Partial<BookDetail> = {}): BookDetail {
  return {
    id: 42,
    title: 'Leviathan Wakes',
    authors: [{ name: 'James S. A. Corey' }],
    narrators: [{ name: 'Jefferson Mays' }],
    status: 'wanted',
    ...overrides,
  } as unknown as BookDetail;
}

function makeLog(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
}

function makeDeps(overrides: Partial<AddBookLadderDeps> = {}): AddBookLadderDeps {
  return {
    bookService: {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
      create: vi.fn().mockResolvedValue(makeBook()),
      getById: vi.fn().mockResolvedValue(null),
    },
    eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    ...overrides,
  } as AddBookLadderDeps;
}

const input = {
  title: 'Leviathan Wakes',
  authors: [{ name: 'James S. A. Corey' }],
  asin: 'B0000TEST1',
  narrators: ['Jefferson Mays'],
  duration: 7200,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addBookThroughLadder', () => {
  it('passes exactly the identity fields to findDuplicate', async () => {
    const deps = makeDeps();
    await addBookThroughLadder(deps, input, makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      asin: 'B0000TEST1',
      narrators: ['Jefferson Mays'],
      duration: 7200,
    });
  });

  it('passes the normalized production type to findDuplicate when the provider supplied a format', async () => {
    const deps = makeDeps();
    await addBookThroughLadder(deps, { ...input, formatType: '  Abridged ' }, makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ productionType: 'abridged' }),
    );
  });

  it.each([
    ['an unrecognized format', 'radio play'],
    ['an empty format', ''],
    ['a null format', null],
  ])('normalizes %s to the no-signal unknown production type', async (_label, formatType) => {
    const deps = makeDeps();
    await addBookThroughLadder(deps, { ...input, formatType }, makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ productionType: 'unknown' }),
    );
  });

  it('omits productionType entirely when no formatType was supplied', async () => {
    const deps = makeDeps();
    await addBookThroughLadder(deps, input, makeLog());

    const candidate = vi.mocked(deps.bookService.findDuplicate).mock.calls[0]![0];
    expect(candidate).not.toHaveProperty('productionType');
  });

  it('persists the normalized production type on the created row', async () => {
    const deps = makeDeps();
    await addBookThroughLadder(deps, { ...input, formatType: 'UNABRIDGED' }, makeLog());

    expect(deps.bookService.create).toHaveBeenCalledWith(
      expect.objectContaining({ productionType: 'unabridged' }),
    );
  });

  it('omits absent optional identity fields rather than sending undefined keys', async () => {
    const deps = makeDeps();
    await addBookThroughLadder(deps, { title: 'Bare', authors: [] }, makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith({ title: 'Bare', authors: [] });
  });

  it('creates the book and records a book_added event on a different recording', async () => {
    const created = makeBook({ id: 7 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockResolvedValue(created);

    const result = await addBookThroughLadder(deps, input, makeLog());

    expect(result).toEqual({ outcome: 'created', book: created });
    expect(deps.bookService.create).toHaveBeenCalledWith(input);
    expect(deps.eventHistory.create).toHaveBeenCalledWith({
      bookId: 7,
      bookTitle: 'Leviathan Wakes',
      authorName: 'James S. A. Corey',
      narratorName: 'Jefferson Mays',
      eventType: 'book_added',
      source: 'manual',
    });
  });

  it('returns the same-recording incumbent without creating anything', async () => {
    const incumbent = makeBook({ id: 3 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: incumbent, hasIncumbent: true,
    });

    const result = await addBookThroughLadder(deps, input, makeLog());

    expect(result).toEqual({ outcome: 'duplicate', verdict: 'same-recording', book: incumbent });
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('carries the recording review reason on a review verdict', async () => {
    const incumbent = makeBook({ id: 5 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: incumbent, hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
    });

    const result = await addBookThroughLadder(deps, input, makeLog());

    expect(result).toEqual({
      outcome: 'duplicate', verdict: 'review', book: incumbent, recordingReviewReason: 'narrator-no-signal',
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('still creates when a non-different verdict carries no representative book', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: null, hasIncumbent: true,
    });

    const result = await addBookThroughLadder(deps, input, makeLog());

    expect(result.outcome).toBe('created');
    expect(deps.bookService.create).toHaveBeenCalledTimes(1);
  });

  it('maps a create-time ASIN race to owned-race carrying the incumbent', async () => {
    const owner = makeBook({ id: 9 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(
      new OwnedRecordingError({ existingBookId: 9, title: 'Leviathan Wakes', reason: 'asin-owned' }),
    );
    vi.mocked(deps.bookService.getById).mockResolvedValue(owner);

    const result = await addBookThroughLadder(deps, input, makeLog());

    expect(result).toEqual({ outcome: 'owned-race', existingBookId: 9, bookTitle: 'Leviathan Wakes', book: owner });
    expect(deps.bookService.getById).toHaveBeenCalledWith(9);
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  describe('#2199 owned-race identity survives a failed hydration', () => {
    function raceDeps(): AddBookLadderDeps {
      const deps = makeDeps();
      vi.mocked(deps.bookService.create).mockRejectedValue(
        new OwnedRecordingError({ existingBookId: 9, title: 'Leviathan Wakes (owned)', reason: 'asin-owned' }),
      );
      return deps;
    }

    it('keeps the error identity when the incumbent read resolves null', async () => {
      const deps = raceDeps();
      vi.mocked(deps.bookService.getById).mockResolvedValue(null);

      const result = await addBookThroughLadder(deps, input, makeLog());

      expect(result).toEqual({
        outcome: 'owned-race', existingBookId: 9, bookTitle: 'Leviathan Wakes (owned)', book: null,
      });
    });

    // getById runs three awaited queries; a rejection there must not turn a committed collision
    // into a 500 (spec review F7).
    it('keeps the error identity and logs when the incumbent read rejects', async () => {
      const deps = raceDeps();
      const log = makeLog();
      vi.mocked(deps.bookService.getById).mockRejectedValue(new Error('db handle closed'));

      const result = await addBookThroughLadder(deps, input, log);

      expect(result).toEqual({
        outcome: 'owned-race', existingBookId: 9, bookTitle: 'Leviathan Wakes (owned)', book: null,
      });
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ existingId: 9, error: expect.anything() }),
        'Failed to hydrate the owned-race incumbent',
      );
    });
  });

  describe('#2199 overrideRecordingReview', () => {
    function reviewDeps(): AddBookLadderDeps {
      const deps = makeDeps();
      vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
        verdict: 'review', book: makeBook({ id: 5 }), hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
      });
      return deps;
    }

    it('turns an undecided review into a create', async () => {
      const created = makeBook({ id: 21 });
      const deps = reviewDeps();
      vi.mocked(deps.bookService.create).mockResolvedValue(created);

      const result = await addBookThroughLadder(deps, { ...input, overrideRecordingReview: true }, makeLog());

      expect(result).toEqual({ outcome: 'created', book: created });
      expect(deps.bookService.create).toHaveBeenCalledTimes(1);
    });

    it('never relaxes a same-recording refusal', async () => {
      const incumbent = makeBook({ id: 3 });
      const deps = makeDeps();
      vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
        verdict: 'same-recording', book: incumbent, hasIncumbent: true,
      });

      const result = await addBookThroughLadder(deps, { ...input, overrideRecordingReview: true }, makeLog());

      expect(result).toEqual({ outcome: 'duplicate', verdict: 'same-recording', book: incumbent });
      expect(deps.bookService.create).not.toHaveBeenCalled();
    });

    it('never relaxes a create-time ASIN race', async () => {
      const deps = makeDeps();
      vi.mocked(deps.bookService.create).mockRejectedValue(
        new OwnedRecordingError({ existingBookId: 9, title: 'Leviathan Wakes', reason: 'asin-owned' }),
      );
      vi.mocked(deps.bookService.getById).mockResolvedValue(makeBook({ id: 9 }));

      const result = await addBookThroughLadder(deps, { ...input, overrideRecordingReview: true }, makeLog());

      expect(result.outcome).toBe('owned-race');
    });

    it('still holds a review when the flag is absent or false', async () => {
      for (const flag of [undefined, false]) {
        vi.clearAllMocks();
        const deps = reviewDeps();

        const result = await addBookThroughLadder(deps, { ...input, overrideRecordingReview: flag }, makeLog());

        expect(result.outcome).toBe('duplicate');
        expect(deps.bookService.create).not.toHaveBeenCalled();
      }
    });

    it('does not forward the transient flag to the create payload', async () => {
      const deps = reviewDeps();
      await addBookThroughLadder(deps, { ...input, overrideRecordingReview: true }, makeLog());

      expect(deps.bookService.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ overrideRecordingReview: expect.anything() }),
      );
    });
  });

  it('reports created and logs when the book_added write rejects — the row is the point of no return', async () => {
    const created = makeBook({ id: 11 });
    const log = makeLog();
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockResolvedValue(created);
    vi.mocked(deps.eventHistory.create).mockRejectedValue(new Error('events table locked'));

    const result = await addBookThroughLadder(deps, input, log);

    expect(result).toEqual({ outcome: 'created', book: created });
    await vi.waitFor(() => {
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        'Failed to record book_added event',
      );
    });
  });

  it('propagates an unexpected create failure to the caller', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(new Error('disk full'));

    await expect(addBookThroughLadder(deps, input, makeLog())).rejects.toThrow('disk full');
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });
});
