import { describe, it, expect } from 'vitest';
import { chunkArray } from './batch.js';

describe('chunkArray', () => {
  it('returns empty array for empty input', () => {
    expect(chunkArray([], 10)).toEqual([]);
  });

  it('returns single chunk when items fit within size', () => {
    expect(chunkArray([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it('splits items into chunks of specified size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('handles exact multiple of chunk size', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('handles chunk size of 1', () => {
    expect(chunkArray([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it('handles chunk size larger than array', () => {
    expect(chunkArray([1, 2], 100)).toEqual([[1, 2]]);
  });
});
