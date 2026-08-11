import { describe, it, expect, vi } from 'vitest';
import type { DuplicateCandidate, DuplicateResolution } from '../book-dedup.js';
import type { BookWithAuthor } from '../book.service.js';
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

    expect(decision).toEqual({ kind: 'same-recording', incumbent, existingBookId: 421 });
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
});
