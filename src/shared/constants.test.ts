import { describe, expect, it } from 'vitest';
import { MAX_COVER_SIZE } from './constants.js';

describe('MAX_COVER_SIZE', () => {
  it('equals 10 * 1024 * 1024 (10 MB)', () => {
    expect(MAX_COVER_SIZE).toBe(10 * 1024 * 1024);
    expect(MAX_COVER_SIZE).toBe(10_485_760);
  });
});
