import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { RateLimitError } from '@core/index.js';
import type { BookMetadata } from '@core/metadata/types.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { addBook } from './index.js';
import type { AddBookDeps, AddBookItem, AddBookRequest } from './index.js';
import type { DuplicateCandidate, DuplicateResolution } from '../book-dedup.js';
import type { BookDetail, BookWithAuthor } from '../book.service.js';

/**
 * #2249: the ASIN the duplicate check sees is the ASIN the row will carry. Every assertion here
 * observes one of the two sides of that identity — the `findDuplicate` candidate and the
 * `bookService.create` payload — because a 409 status alone cannot tell the two arms apart.
 *
 * Doubles are built per test rather than cleared in a `beforeEach`: these cases queue `*Once()`
 * responses, and `vi.clearAllMocks()` does not drain those queues.
 */

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

function detail(asin: string | undefined): BookMetadata {
  return { title: 'Leviathan Wakes', authors: [{ name: 'James S. A. Corey' }], ...(asin !== undefined && { asin }) } as BookMetadata;
}

/**
 * The port is wired by DEFAULT and answers with an ASIN by default. A shared builder that omitted
 * it would put every case in this suite on the "no metadata port configured" branch — the one arm
 * the suite exists to prove is not taken.
 */
function makeDeps(overrides: Partial<AddBookDeps> = {}): AddBookDeps {
  return {
    bookService: {
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false }),
      create: vi.fn().mockResolvedValue(makeBook()),
      getById: vi.fn().mockResolvedValue(null),
    },
    eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    metadataService: { getBook: vi.fn().mockResolvedValue(detail('B0PROVIDER')) },
    ...overrides,
  } as AddBookDeps;
}

/** The production shape this issue is about: the client searched, so it holds a providerId and an
 * author, but the search result carried no ASIN. */
const providerOnly: AddBookItem = {
  title: 'Leviathan Wakes',
  authors: [{ name: 'James S. A. Corey' }],
  narrators: ['Jefferson Mays'],
  providerId: '386446',
};

function request(item: AddBookItem): AddBookRequest {
  return { item, onReview: 'refuse', resolve: 'skip', provenance: { source: 'manual', eventShape: 'snapshot' } };
}

function getBookMock(deps: AddBookDeps) {
  return vi.mocked(deps.metadataService!.getBook);
}

function candidateFrom(deps: AddBookDeps): DuplicateCandidate {
  return vi.mocked(deps.bookService.findDuplicate).mock.calls[0]![0];
}

function createInputFrom(deps: AddBookDeps): Record<string, unknown> {
  return vi.mocked(deps.bookService.create).mock.calls[0]![0] as unknown as Record<string, unknown>;
}

/**
 * A library of one incumbent, answering the way `resolveRecordingIdentity` answers: an equal
 * canonical ASIN short-circuits to `same-recording` before narrators are read, and a candidate
 * without that ASIN falls through to the narrator comparison. Keying the double on the CANDIDATE
 * is what makes these tests observe whether the enrichment reached the decision at all.
 */
function libraryOwning(asin: string, incumbent: BookWithAuthor, fallback: DuplicateResolution['verdict'] = 'different-recording') {
  return vi.fn().mockImplementation((candidate: DuplicateCandidate): Promise<DuplicateResolution> =>
    Promise.resolve(canonicalizeAsin(candidate.asin) === canonicalizeAsin(asin)
      ? { verdict: 'same-recording', book: incumbent, hasIncumbent: true }
      : { verdict: fallback, book: null, hasIncumbent: false }));
}

describe('addBook — the enriched ASIN reaches the duplicate decision (AC1/AC2)', () => {
  it('refuses an owned ASIN as same-recording and never calls create', async () => {
    // The incumbent is spelled differently, so title+author alone cannot find it.
    const incumbent = makeBook({ id: 3, title: 'Leviathan Wakes: Book One of the Expanse' }) as unknown as BookWithAuthor;
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(detail('B0OWNED'));
    vi.mocked(deps.bookService.findDuplicate).mockImplementation(libraryOwning('B0OWNED', incumbent));

    const result = await addBook(deps, request(providerOnly), makeLog());

    expect(result).toEqual({
      outcome: 'duplicate', verdict: 'same-recording', book: incumbent, existingBookId: 3,
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(candidateFrom(deps).asin).toBe('B0OWNED');
  });

  // The narrator arm: without the enrichment this pair is `different-recording` → admit → a doomed
  // INSERT. With it, the ASIN short-circuit answers before narrators are compared.
  it('short-circuits a title+author match whose narrators differ', async () => {
    const incumbent = makeBook({ id: 8, narrators: [{ name: 'Someone Else' }] } as Partial<BookDetail>) as unknown as BookWithAuthor;
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(detail('B0OWNED'));
    vi.mocked(deps.bookService.findDuplicate).mockImplementation(libraryOwning('B0OWNED', incumbent));

    const result = await addBook(deps, request(providerOnly), makeLog());

    expect(result).toMatchObject({ outcome: 'duplicate', verdict: 'same-recording', existingBookId: 8 });
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });

  it('hands the SAME raw ASIN to the duplicate check and to create, and fills nothing else', async () => {
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(detail('b0enriched'));

    await addBook(deps, request(providerOnly), makeLog());

    // Raw, uncanonicalized on both sides: canonicalization lives in the dedup gather and in
    // `createResolved`, and enriching a second opinion here would be a third.
    expect(candidateFrom(deps).asin).toBe('b0enriched');
    expect(createInputFrom(deps).asin).toBe('b0enriched');
    expect(candidateFrom(deps)).toEqual({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      narrators: ['Jefferson Mays'],
      asin: 'b0enriched',
    });
    expect(createInputFrom(deps)).not.toHaveProperty('providerId');
  });

  it('logs the enrichment at info with the provider id it resolved', async () => {
    const deps = makeDeps();
    const log = makeLog();
    getBookMock(deps).mockResolvedValue(detail('B0ENRICHED'));

    await addBook(deps, request(providerOnly), log);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Leviathan Wakes', providerId: '386446', asin: 'B0ENRICHED' }),
      'Enriched book with ASIN from provider',
    );
  });
});

/**
 * AC4. Every row runs on the ADMITTED path, where `create` runs and the `providerId` column is
 * observable; a refusal returns before `create`, so the two halves cannot be read off one fixture.
 */
describe('addBook — the lookup precondition matrix (AC4)', () => {
  const CASES: {
    label: string;
    item: AddBookItem;
    port: boolean;
    calls: number;
    providerIdReachesCreate: boolean;
  }[] = [
    { label: 'a usable caller ASIN needs no lookup', item: { ...providerOnly, asin: 'B0CALLER' }, port: true, calls: 0, providerIdReachesCreate: true },
    { label: 'providerId with no ASIN is looked up', item: providerOnly, port: true, calls: 1, providerIdReachesCreate: false },
    { label: 'a blank caller ASIN is no ASIN', item: { ...providerOnly, asin: '' }, port: true, calls: 1, providerIdReachesCreate: false },
    { label: 'a whitespace-only caller ASIN is no ASIN', item: { ...providerOnly, asin: '   ' }, port: true, calls: 1, providerIdReachesCreate: false },
    { label: 'an empty providerId is not a lookup', item: { ...providerOnly, providerId: '' }, port: true, calls: 0, providerIdReachesCreate: true },
    { label: 'an authorless item is never enriched', item: { ...providerOnly, authors: [] }, port: true, calls: 0, providerIdReachesCreate: true },
    { label: 'no metadata port means no lookup', item: providerOnly, port: false, calls: 0, providerIdReachesCreate: true },
    { label: 'neither identifier is a lookup', item: { title: 'Bare', authors: [{ name: 'A' }] }, port: true, calls: 0, providerIdReachesCreate: false },
  ];

  it.each(CASES)('$label', async ({ item, port, calls, providerIdReachesCreate }) => {
    const deps = makeDeps(port ? {} : { metadataService: undefined });
    await addBook(deps, request(item), makeLog());

    expect(port ? getBookMock(deps).mock.calls.length : 0).toBe(calls);
    if (providerIdReachesCreate) {
      expect(createInputFrom(deps)).toHaveProperty('providerId', item.providerId);
    } else {
      expect(createInputFrom(deps)).not.toHaveProperty('providerId');
    }
  });

  // A lookup that answered nothing still consumed the one fetch this add is allowed; forwarding
  // `providerId` afterwards would let `BookService.resolveCreateInput` ask the provider again.
  it.each([
    ['a null answer', null],
    ['an ASIN-less answer', detail(undefined)],
  ])('strips providerId after %s so BookService cannot re-fetch', async (_label, answer) => {
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(answer);

    await addBook(deps, request(providerOnly), makeLog());

    expect(getBookMock(deps)).toHaveBeenCalledTimes(1);
    expect(createInputFrom(deps)).not.toHaveProperty('providerId');
  });

  it('asks the provider exactly once with the caller-supplied providerId', async () => {
    const deps = makeDeps();
    await addBook(deps, request(providerOnly), makeLog());

    expect(getBookMock(deps)).toHaveBeenCalledTimes(1);
    expect(getBookMock(deps)).toHaveBeenCalledWith('386446');
  });

  it('makes no lookup on the refused path either — the decision already had the ASIN', async () => {
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(detail('B0OWNED'));
    vi.mocked(deps.bookService.findDuplicate).mockImplementation(
      libraryOwning('B0OWNED', makeBook({ id: 3 }) as unknown as BookWithAuthor),
    );

    await addBook(deps, request(providerOnly), makeLog());

    expect(getBookMock(deps)).toHaveBeenCalledTimes(1);
    expect(deps.bookService.create).not.toHaveBeenCalled();
  });
});

/** AC5. A provider that failed is not evidence of a duplicate, and must never become a verdict. */
describe('addBook — a failed or empty enrichment leaves the add on the caller identity (AC5)', () => {
  const NO_SIGNAL: [string, () => Promise<BookMetadata | null>][] = [
    ['a generic throw', () => Promise.reject(new Error('provider exploded'))],
    ['a rate limit', () => Promise.reject(new RateLimitError(1000, 'audible'))],
    ['a null answer', () => Promise.resolve(null)],
    ['an absent ASIN', () => Promise.resolve(detail(undefined))],
    ['a whitespace-only ASIN', () => Promise.resolve(detail('   '))],
  ];

  it.each(NO_SIGNAL)('creates the row from the caller identity after %s', async (_label, answer) => {
    const deps = makeDeps();
    getBookMock(deps).mockImplementation(answer);

    const result = await addBook(deps, request(providerOnly), makeLog());

    expect(result.outcome).toBe('created');
    expect(candidateFrom(deps)).not.toHaveProperty('asin');
    expect(createInputFrom(deps)).not.toHaveProperty('asin');
    expect(deps.bookService.create).toHaveBeenCalledTimes(1);
  });

  // Key-absent vs blank is a real distinction downstream, so a no-signal answer must not overwrite
  // the caller's own blank with the provider's.
  it('leaves a blank caller ASIN exactly as the caller left it', async () => {
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(detail('   '));

    await addBook(deps, request({ ...providerOnly, asin: '' }), makeLog());

    expect(candidateFrom(deps).asin).toBe('');
    expect(createInputFrom(deps).asin).toBe('');
  });

  it.each([
    ['a generic throw', new Error('provider exploded')],
    ['a rate limit', new RateLimitError(1000, 'audible')],
  ])('logs %s at warn and continues', async (_label, error) => {
    const deps = makeDeps();
    const log = makeLog();
    getBookMock(deps).mockRejectedValue(error);

    const result = await addBook(deps, request(providerOnly), log);

    expect(result.outcome).toBe('created');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: '386446', error: expect.anything() }),
      'ASIN enrichment failed',
    );
  });
});

/**
 * AC7. `gatherIncumbentIds`'s zero-author arm is gated on the candidate having NO ASIN, so an
 * authorless item that arrived enriched would stop being compared against exact-title zero-author
 * rows — the enrichment would SHRINK the incumbent set. The precondition, not the shared gather,
 * is what prevents that.
 */
describe('addBook — an authorless item decides exactly as it does today (AC7)', () => {
  const authorless: AddBookItem = { title: 'Leviathan Wakes', authors: [], providerId: '386446' };

  it('refuses the exact-title zero-author incumbent it would otherwise miss', async () => {
    const incumbent = makeBook({ id: 12, authors: [] }) as unknown as BookWithAuthor;
    const deps = makeDeps();
    getBookMock(deps).mockResolvedValue(detail('B0OWNED'));
    vi.mocked(deps.bookService.findDuplicate).mockResolvedValue({
      verdict: 'review', book: incumbent, hasIncumbent: true, recordingReviewReason: 'narrator-no-signal',
    });

    const result = await addBook(deps, request(authorless), makeLog());

    expect(canonicalizeAsin(candidateFrom(deps).asin)).toBeNull();
    expect(result).toEqual({
      outcome: 'duplicate',
      verdict: 'review',
      book: incumbent,
      existingBookId: 12,
      recordingReviewReason: 'narrator-no-signal',
    });
    expect(deps.bookService.create).not.toHaveBeenCalled();
    expect(getBookMock(deps)).not.toHaveBeenCalled();
  });

  it('forwards providerId on the admitted path so BookService still enriches it late', async () => {
    const deps = makeDeps();

    const result = await addBook(deps, request(authorless), makeLog());

    expect(result.outcome).toBe('created');
    expect(getBookMock(deps)).not.toHaveBeenCalled();
    expect(createInputFrom(deps)).toHaveProperty('providerId', '386446');
  });
});
