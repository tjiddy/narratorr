import { describe, it, expect } from 'vitest';
import { DURATION_TOLERANCE_SECONDS, withinDurationTolerance } from './duration-tolerance.js';

describe('withinDurationTolerance (#1854)', () => {
  it('the band is 90 absolute seconds', () => {
    expect(DURATION_TOLERANCE_SECONDS).toBe(90);
  });

  it('true at Δ0', () => {
    expect(withinDurationTolerance(3600, 3600)).toBe(true);
  });

  it('true at exactly Δ90 (inclusive boundary)', () => {
    expect(withinDurationTolerance(3600, 3690)).toBe(true);
    expect(withinDurationTolerance(3690, 3600)).toBe(true);
  });

  it('false at Δ91 (one tick beyond)', () => {
    expect(withinDurationTolerance(3600, 3691)).toBe(false);
    expect(withinDurationTolerance(3691, 3600)).toBe(false);
  });

  it('argument order is symmetric', () => {
    expect(withinDurationTolerance(100, 250)).toBe(withinDurationTolerance(250, 100));
    expect(withinDurationTolerance(3600, 3650)).toBe(withinDurationTolerance(3650, 3600));
  });

  // The predicate does NO guarding — it is a plain absolute-difference test. Call
  // sites own the present/positive guards, so a future caller must not assume the
  // predicate filters out zero/negative inputs.
  it('does no guarding — zero and negative inputs behave as plain absolute difference', () => {
    expect(withinDurationTolerance(0, 0)).toBe(true);
    expect(withinDurationTolerance(0, 50)).toBe(true);
    expect(withinDurationTolerance(0, 200)).toBe(false);
    // Negative inputs: |(-10) - 10| = 20 ≤ 90 → true; |(-100) - 100| = 200 → false.
    expect(withinDurationTolerance(-10, 10)).toBe(true);
    expect(withinDurationTolerance(-100, 100)).toBe(false);
  });
});
