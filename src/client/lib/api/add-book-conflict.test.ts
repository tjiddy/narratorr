import { describe, it, expect } from 'vitest';
import {
  parseAddBookConflict,
  readAddBookConflict,
  formatReviewConflictMessage,
  formatReviewIncumbentClause,
  formatReviewConflictSentence,
  REVIEW_CONFLICT_LABEL,
} from './add-book-conflict.js';
import { ApiError } from './client.js';

describe('parseAddBookConflict — the POST /api/books 409 body (#2199)', () => {
  it('reads the review discriminator with the incumbent identity', () => {
    expect(parseAddBookConflict({ conflict: 'review', id: 88, title: 'Piranesi' })).toEqual({
      conflict: 'review', incumbentId: 88, incumbentTitle: 'Piranesi',
    });
  });

  it.each(['same-recording', 'owned-race'] as const)('reads the %s discriminator', (conflict) => {
    expect(parseAddBookConflict({ conflict, id: 7, title: 'Owned' }).conflict).toBe(conflict);
  });

  // A server that predates the discriminator, or any unrecognized value, must degrade to the
  // pre-#2199 ownership claim rather than to an unowned card.
  it.each([
    ['an absent discriminator', { id: 7, title: 'Owned' }],
    ['an unrecognized discriminator', { conflict: 'maybe', id: 7, title: 'Owned' }],
    ['a verdict that never 409s', { conflict: 'different-recording', id: 7, title: 'Owned' }],
  ])('reports no conflict for %s while keeping the incumbent id', (_label, body) => {
    const parsed = parseAddBookConflict(body);
    expect(parsed.conflict).toBeNull();
    expect(parsed.incumbentId).toBe(7);
  });

  it.each([
    ['a null body', null],
    ['a string body', 'nope'],
    ['a body with a non-numeric id', { conflict: 'review', id: '7', title: 7 }],
  ])('degrades to nulls for %s', (_label, body) => {
    expect(parseAddBookConflict(body)).toEqual({
      conflict: body && typeof body === 'object' ? 'review' : null, incumbentId: null, incumbentTitle: null,
    });
  });

  // An array clears the `typeof body === 'object'` guard, so it reaches safeParse with an undefined
  // discriminator — the ownership degrade, never the review arm.
  it('degrades an array body to the ownership claim, not review', () => {
    expect(parseAddBookConflict([])).toEqual({
      conflict: null, incumbentId: null, incumbentTitle: null,
    });
  });
});

describe('readAddBookConflict — the single-homed add-path 409 gate (#2258)', () => {
  it('reads the review discriminator with the incumbent identity off a real 409', () => {
    expect(readAddBookConflict(new ApiError(409, { conflict: 'review', id: 88, title: 'Piranesi' }))).toEqual({
      conflict: 'review', incumbentId: 88, incumbentTitle: 'Piranesi',
    });
  });

  it.each(['same-recording', 'owned-race'] as const)('reads the %s discriminator, id preserved', (conflict) => {
    expect(readAddBookConflict(new ApiError(409, { conflict, id: 7, title: 'Owned' }))).toEqual({
      conflict, incumbentId: 7, incumbentTitle: 'Owned',
    });
  });

  // The null degrade every surface's ownership fallthrough depends on.
  it.each([
    ['an absent discriminator', { id: 7, title: 'Owned' }],
    ['an unrecognized discriminator', { conflict: 'bogus', id: 7, title: 'Owned' }],
    ['a verdict that never 409s', { conflict: 'different-recording', id: 7, title: 'Owned' }],
  ])('reports no conflict for %s while keeping the incumbent id', (_label, body) => {
    expect(readAddBookConflict(new ApiError(409, body))).toEqual({
      conflict: null, incumbentId: 7, incumbentTitle: 'Owned',
    });
  });

  // Expected values are spelled out per row rather than derived from `typeof body`: an array clears
  // a `typeof body === 'object'` guard, so a derived expectation would compute the wrong answer.
  it.each([
    ['a null body', null],
    ['a string body', 'nope'],
    ['an array body', []],
  ])('degrades %s to all nulls without throwing', (_label, body) => {
    expect(readAddBookConflict(new ApiError(409, body))).toEqual({
      conflict: null, incumbentId: null, incumbentTitle: null,
    });
  });

  // The gate is 409 and only 409: a neighbouring status carrying a review body must not be read as
  // a conflict at all. Widening the gate to any 4xx passes every case above and reds only here.
  it.each([400, 408, 410, 500])('returns null for status %i even when the body carries a review verdict', (status) => {
    expect(readAddBookConflict(new ApiError(status, { conflict: 'review', id: 88, title: 'Piranesi' }))).toBeNull();
  });

  // The class check, not a duck-typed `status` read: the plain-object row is what distinguishes them.
  it.each([
    ['a plain Error', new Error('boom')],
    ['a plain object shaped like a 409', { status: 409, body: { conflict: 'review' } }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
  ])('returns null for %s', (_label, error) => {
    expect(readAddBookConflict(error)).toBeNull();
  });

  it('agrees with the review copy on the incumbent title it hands over', () => {
    const details = readAddBookConflict(new ApiError(409, { conflict: 'review', id: 88, title: 'Piranesi' }));

    expect(formatReviewConflictMessage(details!.incumbentTitle)).toBe(
      "Possible duplicate (review): may be the same recording as 'Piranesi'",
    );
  });
});

describe('formatReviewConflictMessage — the shared review-409 toast copy (#2212)', () => {
  it('names the incumbent when the 409 body carried its title', () => {
    expect(formatReviewConflictMessage('Piranesi')).toBe(
      "Possible duplicate (review): may be the same recording as 'Piranesi'",
    );
  });

  // A blank title must not render empty quotes, so every non-naming input takes the generic copy.
  it.each([
    ['a null title', null],
    ['an empty title', ''],
    ['a whitespace-only title', '   '],
  ])('falls back to the generic wording for %s', (_label, title) => {
    expect(formatReviewConflictMessage(title)).toBe(
      'Possible duplicate (review): may be the same recording as a book already in your library',
    );
  });

  it('agrees with the parser on the incumbent title it renders', () => {
    const { incumbentTitle } = parseAddBookConflict({ conflict: 'review', id: 88, title: 'Piranesi' });

    expect(formatReviewConflictMessage(incumbentTitle)).toBe(
      "Possible duplicate (review): may be the same recording as 'Piranesi'",
    );
  });
});

// The toast and the Search card's badge sentence are two renderings of one verdict; before #2258
// each spelled its own blank-title rule, and the card's raw-truthiness branch quoted whitespace.
describe('the shared review prose (#2258)', () => {
  it('spells the badge label once', () => {
    expect(REVIEW_CONFLICT_LABEL).toBe('Possible duplicate (review)');
  });

  it('names the incumbent in the clause when the 409 body carried its title', () => {
    expect(formatReviewIncumbentClause('Piranesi')).toBe("may be the same recording as 'Piranesi'");
  });

  // One trim rule, not three coincidences: null, empty and whitespace-only are the same input class.
  it.each([
    ['a null title', null],
    ['an empty title', ''],
    ['a whitespace-only title', '   '],
  ])('drops the name from the clause for %s', (_label, title) => {
    expect(formatReviewIncumbentClause(title)).toBe('may be the same recording as a book already in your library');
  });

  it('sentence-cases and terminates the clause for the badge, naming the incumbent', () => {
    expect(formatReviewConflictSentence('Piranesi')).toBe("May be the same recording as 'Piranesi'.");
  });

  // The whitespace-only row is the one authorized rendered-output change of #2258: the Search card
  // used to quote it verbatim. Do NOT "restore" that rendering — the trim rule is the point.
  it.each([
    ['a null title', null],
    ['an empty title', ''],
    ['a whitespace-only title', '   '],
  ])('renders the generic badge sentence for %s', (_label, title) => {
    expect(formatReviewConflictSentence(title)).toBe('May be the same recording as a book already in your library.');
  });

  it('builds the toast copy out of the same label and clause', () => {
    expect(formatReviewConflictMessage('Piranesi')).toBe(
      `${REVIEW_CONFLICT_LABEL}: ${formatReviewIncumbentClause('Piranesi')}`,
    );
  });
});
