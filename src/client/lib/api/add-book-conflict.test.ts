import { describe, it, expect } from 'vitest';
import { parseAddBookConflict } from './add-book-conflict.js';

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
});
