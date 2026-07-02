import { describe, expect, it } from 'vitest';
import { normalizeSeriesName } from './series-normalize.js';

describe('normalizeSeriesName', () => {
  it('lowercases and collapses non-alphanumeric runs', () => {
    expect(normalizeSeriesName('The Stormlight Archive')).toBe('the stormlight archive');
    expect(normalizeSeriesName('Wax & Wayne')).toBe('wax wayne');
    expect(normalizeSeriesName("Hitchhiker's Guide")).toBe('hitchhiker s guide');
    expect(normalizeSeriesName('  multiple   spaces  ')).toBe('multiple spaces');
  });
});
