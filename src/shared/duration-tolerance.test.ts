import { describe, it, expect } from 'vitest';
import { DURATION_TOLERANCE_SECONDS, withinDurationTolerance } from './duration-tolerance.js';

describe('withinDurationTolerance (#1854, widened 2026-07-15)', () => {
  it('the band is 240 absolute seconds', () => {
    expect(DURATION_TOLERANCE_SECONDS).toBe(240);
  });

  it('true at Δ0', () => {
    expect(withinDurationTolerance(3600, 3600)).toBe(true);
  });

  it('true at exactly Δ240 (inclusive boundary)', () => {
    expect(withinDurationTolerance(3600, 3840)).toBe(true);
    expect(withinDurationTolerance(3840, 3600)).toBe(true);
  });

  it('false at Δ241 (one tick beyond)', () => {
    expect(withinDurationTolerance(3600, 3841)).toBe(false);
    expect(withinDurationTolerance(3841, 3600)).toBe(false);
  });

  it('still separates the closest verified different-recording pair (Martian Δ6m)', () => {
    // Bray 653min vs Wheaton 659min — the closest marquee re-record pair in the
    // #1854 catalog study, caught live in the production library. The band must
    // stay below 360s or this real pair silently merges.
    expect(withinDurationTolerance(653 * 60, 659 * 60)).toBe(false);
  });

  it('argument order is symmetric', () => {
    expect(withinDurationTolerance(100, 400)).toBe(withinDurationTolerance(400, 100));
    expect(withinDurationTolerance(3600, 3650)).toBe(withinDurationTolerance(3650, 3600));
  });

  // The predicate does NO guarding — it is a plain absolute-difference test. Call
  // sites own the present/positive guards, so a future caller must not assume the
  // predicate filters out zero/negative inputs.
  it('does no guarding — zero and negative inputs behave as plain absolute difference', () => {
    expect(withinDurationTolerance(0, 0)).toBe(true);
    expect(withinDurationTolerance(0, 200)).toBe(true);
    expect(withinDurationTolerance(0, 500)).toBe(false);
    // Negative inputs: |(-10) - 10| = 20 ≤ 240 → true; |(-200) - 200| = 400 → false.
    expect(withinDurationTolerance(-10, 10)).toBe(true);
    expect(withinDurationTolerance(-200, 200)).toBe(false);
  });
});
