import { describe, expect, it } from 'vitest';
import { MAX_COVER_SIZE, BYTES_PER_GB } from './constants.js';

describe('MAX_COVER_SIZE', () => {
  it('equals 10 * 1024 * 1024 (10 MB)', () => {
    expect(MAX_COVER_SIZE).toBe(10 * 1024 * 1024);
    expect(MAX_COVER_SIZE).toBe(10_485_760);
  });
});

describe('BYTES_PER_GB', () => {
  it('equals 1024^3 (1 GiB)', () => {
    expect(BYTES_PER_GB).toBe(1024 * 1024 * 1024);
    expect(BYTES_PER_GB).toBe(1_073_741_824);
  });
});
