import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import type { Db } from '@db/index.js';
import { resolveDuplicate, toLibraryRecording, toRecordingCandidate } from '../book-dedup.js';
import type { DuplicateCandidate, DuplicateResolution } from '../book-dedup.js';
import { resolveRecordingIdentity } from '@core/utils/recording-identity.js';
import type { BookService, BookWithAuthor } from '../book.service.js';
import { mockDbChain } from '../../__tests__/helpers.js';
import { decideIntake } from './index.js';
import type { IntakeDeps, IntakeItem } from './index.js';

function makeIncumbent(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 421,
    publicId: 'bk_421',
    title: 'Tehanu',
    asin: 'B01G9EPERE',
    duration: 600,
    productionType: 'unabridged',
    authors: [{ id: 1, name: 'Ursula K. Le Guin', slug: 'ursula-k-le-guin' }],
    narrators: [{ id: 2, name: 'Jenny Sterlin', slug: 'jenny-sterlin' }],
    ...overrides,
  } as unknown as BookWithAuthor;
}

/** Returns the deps plus the double, so every test can read the exact candidate that was built. */
function makeDeps(resolution: DuplicateResolution | Error) {
  const findDuplicate = vi.fn(
    resolution instanceof Error
      ? () => Promise.reject(resolution)
      : () => Promise.resolve(resolution),
  );
  return { deps: { bookService: { findDuplicate } } as unknown as IntakeDeps, findDuplicate };
}

/** The candidate the module actually handed to the duplicate primitive. */
function candidateFrom(findDuplicate: ReturnType<typeof vi.fn>): DuplicateCandidate {
  return findDuplicate.mock.calls[0]![0] as DuplicateCandidate;
}

const MINIMAL: IntakeItem = { title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }] };

describe('decideIntake — verdict arms', () => {
  it('projects same-recording with the hydrated incumbent, not just its id', async () => {
    const incumbent = makeIncumbent();
    const { deps } = makeDeps({ verdict: 'same-recording', book: incumbent, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).toEqual({ kind: 'same-recording', incumbent, existingBookId: 421, incumbentHoldsFile: false });
    // An id-only projection cannot be told apart from a hydrated one by an id assertion.
    expect(decision.kind === 'same-recording' && decision.incumbent).toBe(incumbent);
  });

  it('projects review with the hydrated incumbent and the machine reason', async () => {
    const incumbent = makeIncumbent({ id: 77 });
    const { deps } = makeDeps({
      verdict: 'review',
      book: incumbent,
      hasIncumbent: true,
      recordingReviewReason: 'production-type-mismatch',
    });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).toEqual({
      kind: 'review',
      incumbent,
      existingBookId: 77,
      recordingReviewReason: 'production-type-mismatch',
    });
  });

  it('projects a review with no incumbent as a null incumbent and a null id', async () => {
    const { deps } = makeDeps({ verdict: 'review', book: null, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).toEqual({ kind: 'review', incumbent: null, existingBookId: null });
  });

  it('omits recordingReviewReason as a KEY when the resolution carries none', async () => {
    const { deps } = makeDeps({ verdict: 'review', book: makeIncumbent(), hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).not.toHaveProperty('recordingReviewReason');
  });

  it('projects a no-incumbent different-recording as admit with hasIncumbent false', async () => {
    const { deps } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).toEqual({ kind: 'admit', hasIncumbent: false });
  });

  it('projects a different recording OF AN OWNED TITLE as admit with hasIncumbent true', async () => {
    const { deps } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    // `book` is null in both different-recording producers, so this flag is the only signal.
    expect(decision).toEqual({ kind: 'admit', hasIncumbent: true });
  });
});

/**
 * #2435: a `same-recording` incumbent that holds no file is the record an offered file should
 * FULFIL, not a duplicate of it. The distinction is computed here, once, from the already-hydrated
 * row; only the two import-path consumers read it.
 */
describe('decideIntake — incumbentHoldsFile', () => {
  it('reports a file-holding incumbent without disturbing the rest of the arm', async () => {
    const incumbent = makeIncumbent({ path: '/library/A/B' });
    const { deps } = makeDeps({ verdict: 'same-recording', book: incumbent, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).toEqual({
      kind: 'same-recording', incumbent, existingBookId: 421, incumbentHoldsFile: true,
    });
  });

  // Whitespace is the value a bare `!path` check and a trimming one disagree about.
  it.each([
    ['null', null, false],
    ['empty string', '', false],
    ['whitespace only', '   ', false],
    ['a real path', '/library/A/B', true],
  ])('classifies a %s path as holdsFile=%s', async (_label, path, expected) => {
    const incumbent = makeIncumbent({ path: path as string | null });
    const { deps } = makeDeps({ verdict: 'same-recording', book: incumbent, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision.kind === 'same-recording' && decision.incumbentHoldsFile).toBe(expected);
  });

  it('treats a same-recording verdict with NO incumbent row as not-file-holding', async () => {
    // There is no id to attach to, so the consumers must fall back to their skip behaviour.
    const { deps } = makeDeps({ verdict: 'same-recording', book: null, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).toEqual({
      kind: 'same-recording', incumbent: null, existingBookId: null, incumbentHoldsFile: false,
    });
  });

  it('does not put incumbentHoldsFile on the review arm', async () => {
    const { deps } = makeDeps({ verdict: 'review', book: makeIncumbent({ path: '/library/A/B' }), hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    // Key absence: `not.objectContaining` passes on a present-but-undefined key.
    expect(decision).not.toHaveProperty('incumbentHoldsFile');
  });

  it('does not put incumbentHoldsFile on the admit arm', async () => {
    const { deps } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: true });

    const decision = await decideIntake(deps, { item: MINIMAL });

    expect(decision).not.toHaveProperty('incumbentHoldsFile');
  });
});

describe('decideIntake — candidate construction', () => {
  it('passes every supplied field through unchanged', async () => {
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    await decideIntake(deps, {
      item: {
        title: 'Tehanu',
        authors: [{ name: 'Ursula K. Le Guin', asin: 'A1' }],
        asin: 'B01G9EPERE',
        narrators: ['Jenny Sterlin'],
        duration: 600,
        productionType: 'unabridged',
      },
    });

    expect(candidateFrom(findDuplicate)).toEqual({
      title: 'Tehanu',
      authors: [{ name: 'Ursula K. Le Guin', asin: 'A1' }],
      asin: 'B01G9EPERE',
      narrators: ['Jenny Sterlin'],
      duration: 600,
      productionType: 'unabridged',
    });
  });

  it('leaves every omitted field OFF the candidate rather than defaulting it', async () => {
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    await decideIntake(deps, { item: MINIMAL });

    const candidate = candidateFrom(findDuplicate);
    // Key presence, not `toBeUndefined()` — the latter passes against a defaulted undefined.
    expect(Object.keys(candidate).sort()).toEqual(['authors', 'title']);
    expect(candidate).not.toHaveProperty('asin');
    expect(candidate).not.toHaveProperty('narrators');
    expect(candidate).not.toHaveProperty('duration');
    expect(candidate).not.toHaveProperty('productionType');
  });

  // Shape guards, not verdict guards: today each falsy value and its absence converge on the same
  // verdict. They exist so the module cannot start rewriting the caller's shape.
  const FALSY_CASES: [keyof IntakeItem, Partial<IntakeItem>][] = [
    ['duration', { duration: 0 }],
    ['asin', { asin: '' }],
    ['authors', { authors: [] }],
    ['narrators', { narrators: [] }],
  ];

  it.each(FALSY_CASES)('reaches the candidate with a falsy %s exactly as given', async (key, patch) => {
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    await decideIntake(deps, { item: { title: 'Tehanu', ...patch } });

    const candidate = candidateFrom(findDuplicate);
    expect(candidate).toHaveProperty(key);
    expect(candidate[key]).toEqual(patch[key]);
  });

  it('passes an empty title through — the v1 ASIN-only probe shape', async () => {
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    await decideIntake(deps, { item: { title: '', asin: 'B01G9EPERE' } });

    expect(candidateFrom(findDuplicate)).toEqual({ title: '', asin: 'B01G9EPERE' });
  });

  it('passes an explicit null duration through as null', async () => {
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    await decideIntake(deps, { item: { title: 'Tehanu', duration: null } });

    expect(candidateFrom(findDuplicate)).toEqual({ title: 'Tehanu', duration: null });
  });
});

/**
 * #2251 routed v1's add-by-ASIN probe through here, and v1's published 409 has no arm for `review`
 * — `bookExistsV1Schema` requires an `existingId`, so a review verdict there would be a serializer
 * failure, not a graceful degrade. These drive the REAL resolver rather than a stubbed resolution,
 * and observe the DECISION: the route flattens `same-recording` and `review` onto one 409, so a
 * route-status assertion could not attribute a red to the arm under test.
 */
describe('decideIntake — the v1 ASIN-only probe cannot reach the review arm (#2251)', () => {
  const V1_ITEM: IntakeItem = { title: '', asin: 'B01G9EPERE' };

  /** `findDuplicate` backed by the production resolver over a one-row library. */
  function realDeps(incumbent: BookWithAuthor) {
    const db = { select: vi.fn().mockReturnValue(mockDbChain([{ id: incumbent.id }])) } as unknown as Db;
    const findDuplicate = vi.fn((candidate: DuplicateCandidate) =>
      resolveDuplicate(db, async () => incumbent, candidate));
    return { deps: { bookService: { findDuplicate } } as unknown as IntakeDeps, db };
  }

  // A one-sided narrator set is the reviewing signal; the candidate carries none by construction.
  it.each([['exact', 'B01G9EPERE'], ['case-drifted', 'b01g9epere'], ['padded', '  B01G9EPERE ']])(
    'a %s incumbent ASIN resolves to same-recording, never review',
    async (_label, incumbentAsin) => {
      const { deps } = realDeps(makeIncumbent({ asin: incumbentAsin }));

      const decision = await decideIntake(deps, { item: V1_ITEM });

      expect(decision.kind).toBe('same-recording');
      expect(decision).not.toHaveProperty('recordingReviewReason');
      // The 409 needs a hydrated row, not just the verdict.
      expect(decision.kind === 'same-recording' && decision.incumbent?.publicId).toBe('bk_421');
    },
  );

  // The control: the reviewing pair genuinely exists in the primitive, so the assertions above are
  // pinning the ASIN short-circuit rather than an arm that could never fire for any input.
  it('the SAME candidate DOES review against an author-less empty-title incumbent', () => {
    const orphan = makeIncumbent({ title: '', asin: null, authors: [] });

    const { verdict, recordingReviewReason } = resolveRecordingIdentity(
      toRecordingCandidate({ ...V1_ITEM }),
      toLibraryRecording(orphan),
    );

    expect(verdict).toBe('review');
    expect(recordingReviewReason).toBe('narrator-no-signal');
  });

  // ...and that pair is unreachable because gathering it needs the author-less exact-title query,
  // which `book-dedup` gates on `!canonicalAsin`. A v1 ASIN always canonicalizes: the request
  // schema trims and requires min(1), so only the canonical-ASIN query can run.
  it('issues the canonical-ASIN query ONLY — the author-less title branch never runs', async () => {
    const { deps, db } = realDeps(makeIncumbent());

    await decideIntake(deps, { item: V1_ITEM });

    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('decideIntake — failure policy', () => {
  it('propagates the SAME error instance rather than wrapping or reducing it', async () => {
    const boom = new Error('DB connection lost');
    const { deps } = makeDeps(boom);

    await expect(decideIntake(deps, { item: MINIMAL })).rejects.toBe(boom);
  });

  it('always queries — there is no bypass axis that could invent a decision', async () => {
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });

    await decideIntake(deps, { item: MINIMAL });

    expect(findDuplicate).toHaveBeenCalledTimes(1);
  });

  /**
   * #2235 AC6, re-pinned by #2249: staged import routes through here and turns any throw into a
   * terminal `failed` row, so a provider call inside the decision would make a rate limit a
   * permanent verdict. #2249 moved the ASIN lookup into `addBook`, ABOVE this call — the port is
   * reachable from the same deps object a caller passes, and nothing here may reach for it.
   */
  it('performs no provider I/O, even when the caller\'s deps object carries a metadata port', async () => {
    const metadataService = { getBook: vi.fn(), resolveBook: vi.fn() };
    const { deps, findDuplicate } = makeDeps({ verdict: 'different-recording', book: null, hasIncumbent: false });
    const withPort = { ...deps, metadataService, resolver: metadataService };

    await decideIntake(withPort, { item: { ...MINIMAL, asin: 'B01G9EPERE' } });

    expect(findDuplicate).toHaveBeenCalledTimes(1);
    expect(metadataService.getBook).not.toHaveBeenCalled();
    expect(metadataService.resolveBook).not.toHaveBeenCalled();
  });

  // The runtime assertion above cannot see a port that was never passed; this is what pins the
  // decision's dependency surface to the one collaborator it is allowed to have.
  it('declares no provider dependency at all', () => {
    expectTypeOf<IntakeDeps>().toEqualTypeOf<{ bookService: Pick<BookService, 'findDuplicate'> }>();
  });
});
