import { describe, it, expect } from 'vitest';
import { snapshotBookForEvent } from './event-helpers.js';

describe('snapshotBookForEvent', () => {
  it('returns bookTitle, authorName, narratorName from book with multiple authors and narrators', () => {
    const book = {
      title: 'Test Book',
      authors: [{ name: 'Author A' }, { name: 'Author B' }],
      narrators: [{ name: 'Narrator X' }, { name: 'Narrator Y' }],
    };
    const result = snapshotBookForEvent(book);
    expect(result).toEqual({
      bookTitle: 'Test Book',
      authorName: 'Author A, Author B',
      narratorName: 'Narrator X, Narrator Y',
    });
  });

  it('returns null authorName when authors array is empty', () => {
    const book = { title: 'T', authors: [], narrators: [{ name: 'N' }] };
    const result = snapshotBookForEvent(book);
    expect(result.authorName).toBeNull();
  });

  it('returns null narratorName when narrators is null or undefined', () => {
    const book = { title: 'T', authors: [{ name: 'A' }] };
    const result = snapshotBookForEvent(book);
    expect(result.narratorName).toBeNull();
  });

  it('returns single author name without trailing comma', () => {
    const book = { title: 'T', authors: [{ name: 'Solo Author' }], narrators: [] };
    const result = snapshotBookForEvent(book);
    expect(result.authorName).toBe('Solo Author');
  });

  it('always returns bookTitle (required by CreateEventInput)', () => {
    const book = { title: 'My Title' };
    const result = snapshotBookForEvent(book);
    expect(result.bookTitle).toBe('My Title');
  });

  it('returns null authorName when authors is null or undefined', () => {
    const book = { title: 'T', authors: undefined, narrators: [{ name: 'N' }] };
    const result = snapshotBookForEvent(book);
    expect(result.authorName).toBeNull();
  });

  it('returns null narratorName when narrators array is empty', () => {
    const book = { title: 'T', authors: [{ name: 'A' }], narrators: [] };
    const result = snapshotBookForEvent(book);
    expect(result.narratorName).toBeNull();
  });
});
