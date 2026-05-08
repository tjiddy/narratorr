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
