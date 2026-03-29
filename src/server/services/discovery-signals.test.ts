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

describe('computeSeriesGaps — fractional position bug (#196)', () => {
  function makeSeries(positions: number[], seriesName = 'Stormlight Archive') {
    return positions.map((pos, i) => makeBook(i + 1, { seriesName, seriesPosition: pos }));
  }

  function getGap(result: ReturnType<typeof extractSignals>, seriesName = 'Stormlight Archive') {
    return result.seriesGaps.find(g => g.seriesName === seriesName)!;
  }

  describe('integer series (baseline)', () => {
    it('positions [1, 3, 5] → missingPositions = [2, 4], nextPosition = 6', () => {
      const result = extractSignals(makeSeries([1, 3, 5]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([2, 4]);
      expect(gap.nextPosition).toBe(6);
      expect(gap.maxOwned).toBe(5);
    });

    it('positions [1, 2, 3] (no gaps) → missingPositions = [], nextPosition = 4', () => {
      const result = extractSignals(makeSeries([1, 2, 3]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([]);
      expect(gap.nextPosition).toBe(4);
    });

    it('single book [1] → missingPositions = [], nextPosition = 2', () => {
      const result = extractSignals(makeSeries([1]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([]);
      expect(gap.nextPosition).toBe(2);
    });
  });

  describe('fractional series (core bug fix)', () => {
    it('uniform fractional [1.5, 2.5, 4.5] → missingPositions = [3.5], nextPosition = 5.5', () => {
      const result = extractSignals(makeSeries([1.5, 2.5, 4.5]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([3.5]);
      expect(gap.nextPosition).toBe(5.5);
    });

    it('single fractional book [1.5] → missingPositions = [], nextPosition = 2.5', () => {
      const result = extractSignals(makeSeries([1.5]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([]);
      expect(gap.nextPosition).toBe(2.5);
    });

    it('dense fractional [0.5, 1.0, 1.5, 2.0, 3.0] → missingPositions = [2.5], nextPosition = 3.5', () => {
      const result = extractSignals(makeSeries([0.5, 1.0, 1.5, 2.0, 3.0]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([2.5]);
      expect(gap.nextPosition).toBe(3.5);
    });
  });

  describe('mixed integer/fractional', () => {
    it('positions [1, 2.5, 4] → step = 1.5, missingPositions = [], nextPosition = 5.5', () => {
      const result = extractSignals(makeSeries([1, 2.5, 4]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([]);
      expect(gap.nextPosition).toBe(5.5);
    });
  });

  describe('boundary values', () => {
    it('position 0 in series [0, 2, 4] → missingPositions = [1, 3], nextPosition = 5', () => {
      const result = extractSignals(makeSeries([0, 2, 4]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([1, 3]);
      expect(gap.nextPosition).toBe(5);
    });

    it('large series (50+ books, contiguous) → correct gap detection, correct nextPosition', () => {
      const positions = Array.from({ length: 50 }, (_, i) => i + 1);
      const result = extractSignals(makeSeries(positions), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([]);
      expect(gap.nextPosition).toBe(51);
      expect(gap.maxOwned).toBe(50);
    });

    it('duplicate positions [1, 1, 3] → missingPositions = [2], nextPosition = 4', () => {
      const result = extractSignals(makeSeries([1, 1, 3]), []);
      const gap = getGap(result);
      expect(gap.missingPositions).toEqual([2]);
      expect(gap.nextPosition).toBe(4);
    });
  });

  describe('floating-point tolerance', () => {
    it('positions with IEEE 754 drift (e.g., [0.1, 0.2, 0.4]) → gap at 0.3 detected', () => {
      const result = extractSignals(makeSeries([0.1, 0.2, 0.4]), []);
      const gap = getGap(result);
      // 0.1 + 0.1 = 0.2, 0.2 + 0.1 = 0.30000000000000004 — tolerance must handle this
      expect(gap.missingPositions).toHaveLength(1);
      expect(gap.missingPositions[0]).toBeCloseTo(0.3, 9);
      expect(gap.nextPosition).toBeCloseTo(0.5, 9);
    });
  });

  describe('null/missing data paths', () => {
    it('extractSignals([], []) → seriesGaps is empty array, no crash', () => {
      const result = extractSignals([], []);
      expect(result.seriesGaps).toEqual([]);
    });
  });

  describe('end-to-end extractSignals flow', () => {
    it('mix of integer and fractional series returns correct seriesGaps with missingPositions and nextPosition', () => {
      const books = [
        ...makeSeries([1, 3, 5], 'Integer Series'),
        ...makeSeries([1.5, 2.5, 4.5], 'Fractional Series'),
      ];
      const result = extractSignals(books, []);

      const intGap = getGap(result, 'Integer Series');
      expect(intGap.missingPositions).toEqual([2, 4]);
      expect(intGap.nextPosition).toBe(6);

      const fracGap = getGap(result, 'Fractional Series');
      expect(fracGap.missingPositions).toEqual([3.5]);
      expect(fracGap.nextPosition).toBe(5.5);
    });
  });
});
