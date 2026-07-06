import { describe, expect, it } from 'vitest';

import { pickPrimarySeries } from './pick-primary-series.js';

describe('pickPrimarySeries (seriesPrimary ?? series[0])', () => {
  it('returns seriesPrimary when both seriesPrimary and series[] are present (primary wins)', () => {
    const primary = { name: 'Primary', position: 2 };
    expect(
      pickPrimarySeries({ seriesPrimary: primary, series: [{ name: 'Plural', position: 9 }] }),
    ).toBe(primary);
  });

  it('falls back to series[0] when seriesPrimary is absent', () => {
    const first = { name: 'Plural', position: 9 };
    expect(pickPrimarySeries({ series: [first, { name: 'Second' }] })).toBe(first);
  });

  it('returns undefined when neither seriesPrimary nor series[] is present', () => {
    expect(pickPrimarySeries({})).toBeUndefined();
  });

  it('returns undefined for an empty series[] with no seriesPrimary', () => {
    expect(pickPrimarySeries({ series: [] })).toBeUndefined();
  });

  it('returns undefined when bookLike itself is undefined', () => {
    expect(pickPrimarySeries(undefined)).toBeUndefined();
  });

  it('returns undefined when bookLike itself is null', () => {
    expect(pickPrimarySeries(null)).toBeUndefined();
  });

  it('preserves a position === 0 ref intact (guards against a || regression)', () => {
    const primary = { name: 'Zeroth', position: 0 };
    expect(pickPrimarySeries({ seriesPrimary: primary })).toBe(primary);
    const first = { name: 'ZerothFallback', position: 0 };
    expect(pickPrimarySeries({ series: [first] })).toBe(first);
  });

  it('is generic over a ref carrying asin', () => {
    const primary = { name: 'WithAsin', position: 1, asin: 'B00SERIES' };
    const result = pickPrimarySeries({ seriesPrimary: primary });
    expect(result).toEqual({ name: 'WithAsin', position: 1, asin: 'B00SERIES' });
    // Type-level: asin is accessible on the returned ref.
    expect(result?.asin).toBe('B00SERIES');
  });

  it('is generic over a ref whose name is optional', () => {
    const first: { name?: string; position?: number } = { position: 3 };
    expect(pickPrimarySeries({ series: [first] })).toBe(first);
  });
});
