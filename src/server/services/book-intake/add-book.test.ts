import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ProductionType } from '@shared/schemas/book.js';
import { addBook, unreachableExclusion } from './index.js';
import type { AddBookDeps, AddBookItem, AddBookRequest, AddBookSeed, IntakeItem } from './index.js';
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
function request(overrides: Partial<Extract<AddBookRequest, { resolve: 'skip' }>> = {}): AddBookRequest {
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

/**
 * AC9's input contract is a COMPILE-TIME one: a caller either holds a whole write item or holds a
 * seed the resolver must widen, and no request may straddle the two. Nothing at runtime can observe
 * the difference — flatten `AddBookRequest` into one interface with optional `seed`/`identity`/`item`
 * and every other test in this repository stays green — so `pnpm typecheck` is the assertion here
 * and each `@ts-expect-error` goes unused (TS2578) the moment the union opens up.
 *
 * Two rules the cases obey (#1993). Every negative carries exactly ONE defect against the valid
 * baseline above it, and each requiredness case OMITS its field rather than mis-typing it — a wrong
 * VALUE satisfies the directive while leaving requiredness unpinned. The positive assignments are
 * plain (not `expectTypeOf`) so that deleting an arm fails TS2322 rather than silently passing.
 */
describe('addBook — AC9 the AddBookRequest arms (typecheck-backed)', () => {
  const seed: AddBookSeed = { title: 'Leviathan Wakes', author: 'James S. A. Corey' };
  const SNAPSHOT = { source: 'manual', eventShape: 'snapshot' } as const;
  const RESOLVED = { source: 'manual', reason: { seriesName: 'The Expanse' }, eventShape: 'resolved' } as const;

  it('accepts each arm in the exact shape its caller passes', () => {
    const skip: AddBookRequest = { resolve: 'skip', item, onReview: 'refuse', provenance: SNAPSHOT };
    const required: AddBookRequest = {
      resolve: 'required', seed, identity: 'pin', onReview: 'record-and-hold', provenance: RESOLVED,
    };

    expect(skip.resolve).toBe('skip');
    expect(required.resolve).toBe('required');
  });

  it('requires the whole write item on the skip arm and the whole seed pair on the required arm', () => {
    // @ts-expect-error — `item` is required; omission (not a bad value) is what pins that
    const noItem: AddBookRequest = { resolve: 'skip', onReview: 'refuse', provenance: SNAPSHOT };
    // @ts-expect-error — `seed` is required on the required arm
    const noSeed: AddBookRequest = { resolve: 'required', identity: 'pin', onReview: 'refuse', provenance: RESOLVED };
    // @ts-expect-error — `identity` is required: a resolved row's identity owner cannot be defaulted
    const noIdentity: AddBookRequest = { resolve: 'required', seed, onReview: 'refuse', provenance: RESOLVED };

    expect(noItem.resolve).toBe('skip');
    expect(noSeed.resolve).toBe('required');
    expect(noIdentity.resolve).toBe('required');
  });

  it('refuses a request that straddles the two arms', () => {
    // @ts-expect-error — a caller holding a write item has nothing to resolve, so it has no seed
    const skipWithSeed: AddBookRequest = { resolve: 'skip', item, seed, onReview: 'refuse', provenance: SNAPSHOT };
    // @ts-expect-error — an identity policy is meaningless with no resolved match to weigh it against
    const skipWithIdentity: AddBookRequest = { resolve: 'skip', item, identity: 'pin', onReview: 'refuse', provenance: SNAPSHOT };
    // @ts-expect-error — the required arm's write item is the resolve step's OUTPUT, never an input
    const requiredWithItem: AddBookRequest = { resolve: 'required', seed, identity: 'pin', item, onReview: 'refuse', provenance: RESOLVED };

    expect(skipWithSeed.resolve).toBe('skip');
    expect(skipWithIdentity.resolve).toBe('skip');
    expect(requiredWithItem.resolve).toBe('required');
  });

  it('closes the resolve discriminant to the two built arms', () => {
    // @ts-expect-error — 'deferred' is not an AddBookResolve; the union admits no third arm
    const bogus: AddBookRequest = { resolve: 'deferred', item, onReview: 'refuse', provenance: SNAPSHOT };

    expect(bogus.resolve).toBe('deferred');
  });

  // The discrimination itself, not merely the arms' contents: on a flattened interface with optional
  // cross-arm fields these reads are legal, so both directives go unused and TS2578 reds.
  it('keeps each arm\'s fields unreachable from the other', () => {
    const skip: AddBookRequest = { resolve: 'skip', item, onReview: 'refuse', provenance: SNAPSHOT };
    const required: AddBookRequest = {
      resolve: 'required', seed, identity: 'pin', onReview: 'record-and-hold', provenance: RESOLVED,
    };

    // @ts-expect-error — `seed` exists only on the required arm
    expect(skip.seed).toBeUndefined();
    // @ts-expect-error — `item` exists only on the skip arm
    expect(required.item).toBeUndefined();
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

    expect(result).toEqual({
      outcome: 'duplicate', verdict: 'same-recording', book: incumbent, existingBookId: 3,
    });
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
      outcome: 'duplicate', verdict: 'review', book: incumbent, existingBookId: 5, recordingReviewReason: 'narrator-no-signal',
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
  // silently disables ASIN enrichment for every caller this pipeline does not enrich itself. These
  // deps wire no metadata port, so no pre-decision lookup is attempted and the late one is the only
  // one there is; the stripped half of the rule lives in `add-book-asin-enrichment.test.ts` (#2249).
  it('forwards providerId when no pre-decision lookup was attempted', async () => {
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

    expect(result).toEqual({ outcome: 'created', book: created, authorName: 'James S. A. Corey' });
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

    expect(result).toEqual({ outcome: 'created', book: created, authorName: 'James S. A. Corey' });
    expect(deps.bookService.create).toHaveBeenCalledTimes(1);
  });

  it('never relaxes a same-recording refusal', async () => {
    const incumbent = makeBook({ id: 3 });
    const deps = makeDeps();
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'same-recording', book: incumbent, hasIncumbent: true,
    });

    const result = await addBook(deps, request({ onReview: 'override' }), makeLog());

    expect(result).toEqual({
      outcome: 'duplicate', verdict: 'same-recording', book: incumbent, existingBookId: 3,
    });
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

    expect(result).toEqual({ outcome: 'created', book: created, authorName: 'James S. A. Corey' });
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

/**
 * The gate is a port only `ImportListService` supplies. It sits between the ASIN enrichment and the
 * duplicate decision so it keys on the ASIN the row would carry, and it refuses before any write.
 */
describe('addBook — the import-list exclusion gate (#2305)', () => {
  const gate = (match: { id: number } | null) => ({ isExcluded: vi.fn().mockResolvedValue(match) });

  it('refuses an excluded item with the matched exclusion id and creates nothing', async () => {
    const exclusions = gate({ id: 7 });
    const deps = makeDeps({ exclusions });
    const log = makeLog();

    const result = await addBook(deps, request(), log);

    expect(result).toEqual({ outcome: 'excluded', exclusionId: 7 });
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(deps.eventHistory.create).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      { title: 'Leviathan Wakes', asin: 'B0000TEST1', exclusionId: 7 },
      'Import list item refused: book is excluded',
    );
  });

  it('asks the gate for the item identity — title, ASIN and primary author', async () => {
    const exclusions = gate(null);

    await addBook(makeDeps({ exclusions }), request(), makeLog());

    expect(exclusions.isExcluded).toHaveBeenCalledWith({
      title: 'Leviathan Wakes',
      asin: 'B0000TEST1',
      authorName: 'James S. A. Corey',
    });
  });

  it('keys on the ENRICHED ASIN, not the one the provider item arrived with', async () => {
    const exclusions = gate(null);
    const deps = makeDeps({
      exclusions,
      metadataService: { getBook: vi.fn().mockResolvedValue({ asin: 'B0ENRICHED' }) },
    });

    await addBook(deps, request({ item: { ...item, asin: undefined, providerId: 'prov-1' } }), makeLog());

    expect(exclusions.isExcluded).toHaveBeenCalledWith(
      expect.objectContaining({ asin: 'B0ENRICHED' }),
    );
  });

  it('refuses BEFORE the duplicate decision, so the incumbent is never consulted', async () => {
    const deps = makeDeps({ exclusions: gate({ id: 3 }) });

    await addBook(deps, request(), makeLog());

    expect(deps.bookService.findDuplicate).not.toHaveBeenCalled();
  });

  it('creates the book when the gate finds no match', async () => {
    const deps = makeDeps({ exclusions: gate(null) });

    const result = await addBook(deps, request(), makeLog());

    expect(result.outcome).toBe('created');
    expect(deps.bookService.create).toHaveBeenCalled();
  });

  it('never consults a gate the caller did not supply — the manual add surfaces stay ungated', async () => {
    const deps = makeDeps();

    const result = await addBook(deps, request(), makeLog());

    expect(result.outcome).toBe('created');
    expect(deps).not.toHaveProperty('exclusions');
  });

  it('reports no book or verdict on the excluded arm', async () => {
    const result = await addBook(makeDeps({ exclusions: gate({ id: 7 }) }), request(), makeLog());

    expect(result).not.toHaveProperty('book');
    expect(result).not.toHaveProperty('verdict');
  });

  it('propagates a gate read failure to the caller and creates nothing', async () => {
    const exclusions = { isExcluded: vi.fn().mockRejectedValue(new Error('exclusions table locked')) };
    const deps = makeDeps({ exclusions });

    await expect(addBook(deps, request(), makeLog())).rejects.toThrow('exclusions table locked');
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });
});

describe('unreachableExclusion — the arm an ungated caller cannot receive', () => {
  it('throws naming the exclusion id rather than returning a disposition', () => {
    expect(() => unreachableExclusion({ outcome: 'excluded', exclusionId: 12 }))
      .toThrow(/exclusion #12/);
  });
});
