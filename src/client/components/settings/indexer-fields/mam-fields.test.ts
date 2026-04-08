import { describe, it, expect } from 'vitest';
import { getMinDetectionMs } from './mam-detection-timing.js';

describe('getMinDetectionMs', () => {
  it('returns 0 when mode is test', () => {
    expect(getMinDetectionMs('test')).toBe(0);
  });

  it('returns 1000 when mode is production', () => {
    expect(getMinDetectionMs('production')).toBe(1000);
  });

  it('returns 1000 when mode is development', () => {
    expect(getMinDetectionMs('development')).toBe(1000);
  });
});
