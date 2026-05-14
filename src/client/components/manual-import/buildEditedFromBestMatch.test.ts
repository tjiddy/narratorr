import { describe, it, expect } from 'vitest';
import { buildEditedFromBestMatch } from './buildEditedFromBestMatch.js';
import type { BookEditState } from './types.js';
import type { BookMetadata } from '@/lib/api';

const baseFallback: BookEditState = {
  title: 'Fallback Title',
  author: 'Fallback Author',
  series: 'Fallback Series',
};

const baseBestMatch: BookMetadata = {
  title: 'Match Title',
  authors: [{ name: 'Match Author' }],
};

describe('buildEditedFromBestMatch — seriesPosition fallback (#1042)', () => {
  it('preserves fallback.seriesPosition when bestMatch.series omits position', () => {
    const result = buildEditedFromBestMatch(
      { ...baseBestMatch, series: [{ name: 'Match Series' }] },
      { ...baseFallback, seriesPosition: 2.5 },
    );
    expect(result.seriesPosition).toBe(2.5);
  });

  it('preserves fallback.seriesPosition: 0 (regression guard against falsy drop)', () => {
    const result = buildEditedFromBestMatch(
      { ...baseBestMatch, series: [{ name: 'Match Series' }] },
      { ...baseFallback, seriesPosition: 0 },
    );
    expect(result.seriesPosition).toBe(0);
  });

  it('uses bestMatch position when present (overrides fallback)', () => {
    const result = buildEditedFromBestMatch(
      { ...baseBestMatch, series: [{ name: 'Match Series', position: 5 }] },
      { ...baseFallback, seriesPosition: 2 },
    );
    expect(result.seriesPosition).toBe(5);
  });

  it('omits seriesPosition when neither side has one', () => {
    const result = buildEditedFromBestMatch(
      { ...baseBestMatch, series: [{ name: 'Match Series' }] },
      baseFallback,
    );
    expect(result).not.toHaveProperty('seriesPosition');
  });

  it('preserves bestMatch position: 0 (regression guard against falsy drop)', () => {
    const result = buildEditedFromBestMatch(
      { ...baseBestMatch, series: [{ name: 'Match Series', position: 0 }] },
      { ...baseFallback, seriesPosition: 5 },
    );
    expect(result.seriesPosition).toBe(0);
  });
});

describe('buildEditedFromBestMatch — #1097 canonical primary-series preference', () => {
  it('prefers seriesPrimary over series[0] for series and seriesPosition', () => {
    const result = buildEditedFromBestMatch(
      {
        ...baseBestMatch,
        seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
        series: [
          { name: 'Cosmere', position: 5 },
          { name: 'The Stormlight Archive', position: 2 },
        ],
      },
      baseFallback,
    );
    expect(result.series).toBe('The Stormlight Archive');
    expect(result.seriesPosition).toBe(2);
  });

  it('falls back to series[0] when seriesPrimary is absent', () => {
    const result = buildEditedFromBestMatch(
      { ...baseBestMatch, series: [{ name: 'Discworld', position: 9 }] },
      baseFallback,
    );
    expect(result.series).toBe('Discworld');
    expect(result.seriesPosition).toBe(9);
  });
});
