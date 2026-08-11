import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ProductionType } from '@shared/schemas/book.js';
import { addBook, UnimplementedAddPolicyError } from './index.js';
import type { AddBookDeps, AddBookItem, AddBookRequest, IntakeItem } from './index.js';
import type { CreateBookInput } from '../book-create.js';
import { OwnedRecordingError } from '../book-dedup.js';
import type { BookDetail } from '../book.service.js';

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

function makeDeps(overrides: Partial<AddBookDeps> = {}): AddBookDeps {
  return {
    bookService: {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
      create: vi.fn().mockResolvedValue(makeBook()),
      getById: vi.fn().mockResolvedValue(null),
    },
    eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    ...overrides,
  } as AddBookDeps;
}

const item: AddBookItem = {
  title: 'Leviathan Wakes',
  authors: [{ name: 'James S. A. Corey' }],
  asin: 'B0000TEST1',
  narrators: ['Jefferson Mays'],
  duration: 7200,
};

/** The POST /api/books policy: refuse an undecided review, no resolve step, snapshot announcement. */
function request(overrides: Partial<AddBookRequest> = {}): AddBookRequest {
  return {
    item,
    onReview: 'refuse',
    resolve: 'skip',
    provenance: { source: 'manual', eventShape: 'snapshot' },
    ...overrides,
  };
}

/** The exact object handed to `BookService.create`. */
function createInputFrom(deps: AddBookDeps): Record<string, unknown> {
  return vi.mocked(deps.bookService.create).mock.calls[0]![0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// The write item is a superset of the create payload that CONTAINS an IntakeItem. It cannot extend
// one: the two disagree on `authors`, `duration` and `productionType`. These assertions are checked
// by `pnpm typecheck`, not at runtime — the `it()` bodies exist only to name them (#2243 F3).
describe('addBook — AC2 type invariants', () => {
  it('keeps IntakeItem byte-identical to the decision-only shape #2235 shipped', () => {
    expectTypeOf<IntakeItem>().toEqualTypeOf<{
      title: string;
      authors?: { name: string; asin?: string | undefined }[] | undefined;
      asin?: string | undefined;
      narrators?: string[] | undefined;
      duration?: number | null | undefined;
      productionType?: string | null | undefined;
    }>();
  });

  it('contains an IntakeItem and the whole create payload', () => {
    expectTypeOf<AddBookItem>().toExtend<IntakeItem>();
    expectTypeOf<AddBookItem>().toExtend<CreateBookInput>();
  });

  it('keeps the three fields that forbid `extends IntakeItem` at their narrow write-side types', () => {
    expectTypeOf<AddBookItem['duration']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AddBookItem['productionType']>().toEqualTypeOf<ProductionType | undefined>();
    expectTypeOf<AddBookItem['authors']>().toEqualTypeOf<{ name: string; asin?: string | undefined }[]>();
    // An IntakeItem is NOT a write item: it has no title-plus-create-payload obligation.
    expectTypeOf<IntakeItem>().not.toExtend<AddBookItem>();
  });

  it('carries the three CreateBookInput fields the wire schema does not accept', () => {
    expectTypeOf<AddBookItem['status']>().toEqualTypeOf<CreateBookInput['status']>();
    expectTypeOf<AddBookItem['enrichmentStatus']>().toEqualTypeOf<CreateBookInput['enrichmentStatus']>();
    expectTypeOf<AddBookItem['importListId']>().toEqualTypeOf<CreateBookInput['importListId']>();
  });
});

// AC10: the two arms no caller passes yet are rejected BEFORE any read or write, so a future caller
// that wires one up fails loudly instead of silently getting `refuse`/`skip` (#2243 F4).
describe('addBook — AC10 the unimplemented policy arms', () => {
  it.each([
    ['resolve: required', { resolve: 'required' as const }],
    ['onReview: record-and-hold', { onReview: 'record-and-hold' as const }],
    ['provenance.eventShape: resolved', { provenance: { source: 'manual' as const, eventShape: 'resolved' as const } }],
  ])('rejects %s before touching the duplicate check, the create or the event port', async (_label, patch) => {
    const deps = makeDeps();

    await expect(addBook(deps, request(patch), makeLog())).rejects.toBeInstanceOf(UnimplementedAddPolicyError);

    expect(deps.bookService.findDuplicate).not.toHaveBeenCalled();
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('runs the implemented arms', async () => {
    const deps = makeDeps();

    await expect(addBook(deps, request(), makeLog())).resolves.toEqual({ outcome: 'created', book: makeBook() });
    expect(deps.bookService.create).toHaveBeenCalledTimes(1);
  });
});

describe('addBook — the duplicate decision', () => {
  it('passes exactly the identity fields to the decision', async () => {
    const deps = makeDeps();
    await addBook(deps, request(), makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      asin: 'B0000TEST1',
      narrators: ['Jefferson Mays'],
      duration: 7200,
    });
  });

  it('omits absent optional identity fields rather than sending undefined keys', async () => {
    const deps = makeDeps();
    await addBook(deps, request({ item: { title: 'Bare', authors: [] } }), makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith({ title: 'Bare', authors: [] });
  });

  it('returns the same-recording incumbent without creating anything', async () => {
    const incumbent = makeBook({ id: 3 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: incumbent, hasIncumbent: true,
    });

    const result = await addBook(deps, request(), makeLog());

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

    const result = await addBook(deps, request(), makeLog());

    expect(result).toEqual({
      outcome: 'duplicate', verdict: 'review', book: incumbent, recordingReviewReason: 'narrator-no-signal',
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('omits recordingReviewReason as a KEY when the resolver supplied none', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: makeBook({ id: 5 }), hasIncumbent: true,
    });

    const result = await addBook(deps, request(), makeLog());

    expect(result).not.toHaveProperty('recordingReviewReason');
  });

  // AC-5/onReview: the negative that separates `refuse` from the `record-and-hold` arm the bulk
  // callers will use. A refusal here leaves NO trace on the incumbent's history.
  it('writes no event at all when the refuse arm holds a review', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: makeBook({ id: 5 }), hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
    });

    await addBook(deps, request(), makeLog());

    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  // AC9: `decideIntake` types `incumbent` as nullable, and the 409 body spreads it — refusing on a
  // null one answers `{ conflict }` with no id or title. The fallthrough is deliberate.
  it.each(['same-recording', 'review'] as const)(
    'still creates when a %s verdict carries no representative book',
    async (verdict) => {
      const deps = makeDeps();
      vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({ verdict, book: null, hasIncumbent: true });

      const result = await addBook(deps, request(), makeLog());

      expect(result.outcome).toBe('created');
      expect(deps.bookService.create).toHaveBeenCalledTimes(1);
    },
  );
});

describe('addBook — AC3 the wire→create partition', () => {
  it('forwards all fourteen persistence fields, per-author ASINs included', async () => {
    const deps = makeDeps();
    const full: AddBookItem = {
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey', asin: 'A0000AUTH1' }, { name: 'Ty Franck', asin: 'A0000AUTH2' }],
      narrators: ['Jefferson Mays', 'Kevin R. Free'],
      subtitle: 'Book One of the Expanse',
      description: 'Humanity has colonised the solar system.',
      publisher: 'Orbit',
      coverUrl: 'https://example.com/cover.jpg',
      asin: 'B0000TEST1',
      isbn: '978-1-84149-989-9',
      seriesName: 'The Expanse',
      seriesPosition: 1,
      duration: 7200,
      publishedDate: '2011-06-02',
      genres: ['Science Fiction'],
    };

    await addBook(deps, request({ item: full }), makeLog());

    expect(deps.bookService.create).toHaveBeenCalledWith(full);
  });

  // Consumed inside BookService.resolveCreateInput and invisible in the created row, so dropping it
  // silently disables ASIN enrichment.
  it('forwards providerId even though it is not a column', async () => {
    const deps = makeDeps();
    await addBook(deps, request({ item: { ...item, providerId: '386446' } }), makeLog());

    expect(createInputFrom(deps)).toMatchObject({ providerId: '386446' });
  });

  it('translates formatType into productionType instead of forwarding it', async () => {
    const deps = makeDeps();
    await addBook(deps, request({ item: { ...item, formatType: '  Abridged ' } }), makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'abridged' }));
    expect(deps.bookService.create).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'abridged' }));
    expect(createInputFrom(deps)).not.toHaveProperty('formatType');
  });

  it.each([
    ['an unrecognized format', 'radio play'],
    ['an empty format', ''],
    ['a null format', null],
  ])('normalizes %s to the no-signal unknown production type', async (_label, formatType) => {
    const deps = makeDeps();
    await addBook(deps, request({ item: { ...item, formatType } }), makeLog());

    expect(deps.bookService.findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'unknown' }));
    expect(deps.bookService.create).toHaveBeenCalledWith(expect.objectContaining({ productionType: 'unknown' }));
  });

  // AC5: key absence, not `productionType: undefined` — `buildDuplicateCandidate` keeps omission
  // distinguishable from null, and the persisted row still gets BookService's own 'unknown' default.
  it('sets no productionType key on either the candidate or the create input when no format was supplied', async () => {
    const deps = makeDeps();
    await addBook(deps, request(), makeLog());

    expect(vi.mocked(deps.bookService.findDuplicate).mock.calls[0]![0]).not.toHaveProperty('productionType');
    expect(createInputFrom(deps)).not.toHaveProperty('productionType');
  });
});

describe('addBook — AC7 the snapshot book_added payload', () => {
  it('records every author joined with ", ", a narratorName and no reason', async () => {
    const created = makeBook({
      id: 7,
      authors: [{ name: 'James S. A. Corey' }, { name: 'Ty Franck' }],
      narrators: [{ name: 'Jefferson Mays' }, { name: 'Kevin R. Free' }],
    } as Partial<BookDetail>);
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockResolvedValue(created);

    const result = await addBook(deps, request(), makeLog());

    expect(result).toEqual({ outcome: 'created', book: created });
    expect(deps.eventHistory.create).toHaveBeenCalledWith({
      bookId: 7,
      bookTitle: 'Leviathan Wakes',
      authorName: 'James S. A. Corey, Ty Franck',
      narratorName: 'Jefferson Mays, Kevin R. Free',
      eventType: 'book_added',
      source: 'manual',
    });
    expect(vi.mocked(deps.eventHistory.create).mock.calls[0]![0]).not.toHaveProperty('reason');
  });

  it('takes the event source from provenance rather than hard-coding it', async () => {
    const deps = makeDeps();
    await addBook(deps, request({ provenance: { source: 'import_list', eventShape: 'snapshot' } }), makeLog());

    expect(deps.eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'import_list' }));
  });
});

describe('addBook — AC6 override', () => {
  function reviewDeps(): AddBookDeps {
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

    const result = await addBook(deps, request({ onReview: 'override' }), makeLog());

    expect(result).toEqual({ outcome: 'created', book: created });
    expect(deps.bookService.create).toHaveBeenCalledTimes(1);
  });

  it('never relaxes a same-recording refusal', async () => {
    const incumbent = makeBook({ id: 3 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: incumbent, hasIncumbent: true,
    });

    const result = await addBook(deps, request({ onReview: 'override' }), makeLog());

    expect(result).toEqual({ outcome: 'duplicate', verdict: 'same-recording', book: incumbent });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('never relaxes a create-time ASIN race', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(
      new OwnedRecordingError({ existingBookId: 9, title: 'Leviathan Wakes', reason: 'asin-owned' }),
    );
    vi.mocked(deps.bookService.getById).mockResolvedValue(makeBook({ id: 9 }));

    const result = await addBook(deps, request({ onReview: 'override' }), makeLog());

    expect(result.outcome).toBe('owned-race');
  });

  it('still holds a review under the refuse arm', async () => {
    const deps = reviewDeps();

    const result = await addBook(deps, request(), makeLog());

    expect(result.outcome).toBe('duplicate');
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });
});

describe('addBook — the create-time ASIN race', () => {
  function raceDeps(title = 'Leviathan Wakes (owned)'): AddBookDeps {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(
      new OwnedRecordingError({ existingBookId: 9, title, reason: 'asin-owned' }),
    );
    return deps;
  }

  it('maps the race to owned-race carrying the hydrated incumbent', async () => {
    const owner = makeBook({ id: 9 });
    const deps = raceDeps('Leviathan Wakes');
    vi.mocked(deps.bookService.getById).mockResolvedValue(owner);

    const result = await addBook(deps, request(), makeLog());

    expect(result).toEqual({ outcome: 'owned-race', existingBookId: 9, bookTitle: 'Leviathan Wakes', book: owner });
    expect(deps.bookService.getById).toHaveBeenCalledWith(9);
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });

  it('keeps the error identity when the incumbent read resolves null', async () => {
    const deps = raceDeps();
    vi.mocked(deps.bookService.getById).mockResolvedValue(null);

    const result = await addBook(deps, request(), makeLog());

    expect(result).toEqual({
      outcome: 'owned-race', existingBookId: 9, bookTitle: 'Leviathan Wakes (owned)', book: null,
    });
  });

  // getById runs three awaited queries; a rejection there must not turn a committed collision
  // into a 500 (#2199 spec review F7).
  it('keeps the error identity and logs when the incumbent read rejects', async () => {
    const deps = raceDeps();
    const log = makeLog();
    vi.mocked(deps.bookService.getById).mockRejectedValue(new Error('db handle closed'));

    const result = await addBook(deps, request(), log);

    expect(result).toEqual({
      outcome: 'owned-race', existingBookId: 9, bookTitle: 'Leviathan Wakes (owned)', book: null,
    });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: 9, error: expect.anything() }),
      'Failed to hydrate the owned-race incumbent',
    );
  });
});

describe('addBook — error isolation', () => {
  it('reports created and logs when the book_added write rejects — the row is the point of no return', async () => {
    const created = makeBook({ id: 11 });
    const log = makeLog();
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockResolvedValue(created);
    vi.mocked(deps.eventHistory.create).mockRejectedValue(new Error('events table locked'));

    const result = await addBook(deps, request(), log);

    expect(result).toEqual({ outcome: 'created', book: created });
    await vi.waitFor(() => {
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        'Failed to record book_added event',
      );
    });
  });

  it('propagates an unexpected create failure to the caller and writes no event', async () => {
    const deps = makeDeps();
    vi.mocked(deps.bookService.create).mockRejectedValue(new Error('disk full'));

    await expect(addBook(deps, request(), makeLog())).rejects.toThrow('disk full');
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
  });
});
