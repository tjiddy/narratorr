import { describe, it, expect } from 'vitest';
import { extractSignals } from './discovery-signals.js';

function makeBook(id: number, overrides?: Partial<{
  genres: string[] | null;
  duration: number | null;
  seriesName: string | null;
  seriesPosition: number | null;
}>) {
  return {
    book: { id, genres: null, duration: null, seriesName: null, seriesPosition: null, ...overrides },
    authorName: 'Brandon Sanderson',
  };
}

describe('discovery-signals — narrator affinity from junction tables (#71)', () => {
  it('book with two narrators contributes each name once to narrator affinity counts', () => {
    const books = [makeBook(1)];
    // 3+ narrators needed for threshold — use 3 books each with same narrator to trigger threshold
    const books3 = [makeBook(1), makeBook(2), makeBook(3)];
    const narratorRows = [
      { bookId: 1, narratorName: 'Michael Kramer' },
      { bookId: 1, narratorName: 'Kate Reading' },  // second narrator on same book
      { bookId: 2, narratorName: 'Michael Kramer' },
      { bookId: 3, narratorName: 'Michael Kramer' },
    ];

    const result = extractSignals(books3, narratorRows);

    // Michael Kramer appears in 3 books → at threshold, included
    expect(result.narratorAffinity.get('Michael Kramer')).toBe(3);
    // Kate Reading appears in only 1 book → below threshold, excluded
    expect(result.narratorAffinity.has('Kate Reading')).toBe(false);
  });

  it('two books sharing one narrator both increment that narrator affinity count by 1 (not double-counted)', () => {
    const books = [makeBook(1), makeBook(2), makeBook(3)];
    const narratorRows = [
      { bookId: 1, narratorName: 'Tim Gerard Reynolds' },
      { bookId: 2, narratorName: 'Tim Gerard Reynolds' },
      { bookId: 3, narratorName: 'Tim Gerard Reynolds' },
    ];

    const result = extractSignals(books, narratorRows);

    // Each book contributes 1 count per narrator, not per appearance
    expect(result.narratorAffinity.get('Tim Gerard Reynolds')).toBe(3);
  });

  it('narrator with zero books in library is not present in affinity map', () => {
    const books = [makeBook(1)];
    const narratorRows = [
      { bookId: 1, narratorName: 'Known Narrator' },
    ];

    const result = extractSignals(books, narratorRows);

    // 'Known Narrator' appears in 1 book (below threshold of 3)
    expect(result.narratorAffinity.has('Known Narrator')).toBe(false);
    // Narrator not in any imported book definitely absent
    expect(result.narratorAffinity.has('Never Seen')).toBe(false);
  });
});
