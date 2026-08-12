import { describe, it, expect } from 'vitest';
import { parseAddBookConflict, formatReviewConflictMessage } from './add-book-conflict.js';

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
