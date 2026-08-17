import { describe, it, expect } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import { MISSING_ITEM_GRACE_MS, isWithinMissingItemGrace } from './download-grace.js';

// The predicate takes `now` as an argument, so there is no clock to fake.
const NOW = Date.UTC(2026, 7, 17, 23, 9, 30);

/** A row added `ageMs` before NOW. */
function addedAgo(ageMs: number): Date {
  return new Date(NOW - ageMs);
}

describe('isWithinMissingItemGrace', () => {
  it('treats a just-added row as within grace', () => {
    expect(isWithinMissingItemGrace(addedAgo(0), NOW)).toBe(true);
  });

  it('treats one millisecond short of the window as within grace', () => {
    expect(isWithinMissingItemGrace(addedAgo(MISSING_ITEM_GRACE_MS - 1), NOW)).toBe(true);
  });

  // Exclusive upper bound — an inclusive `<=` reds here and nowhere else.
  it('treats an age of exactly the window as outside grace', () => {
    expect(isWithinMissingItemGrace(addedAgo(MISSING_ITEM_GRACE_MS), NOW)).toBe(false);
  });

  it('treats one millisecond past the window as outside grace', () => {
    expect(isWithinMissingItemGrace(addedAgo(MISSING_ITEM_GRACE_MS + 1), NOW)).toBe(false);
  });

  it('treats an absent addedAt as outside grace', () => {
    expect(isWithinMissingItemGrace(undefined, NOW)).toBe(false);
  });

  it('treats a null addedAt as outside grace', () => {
    expect(isWithinMissingItemGrace(null, NOW)).toBe(false);
  });

  // Legacy/partial rows (and the ~40 hand-built monitor fixtures) must not reach .getTime().
  it('treats a non-Date addedAt as outside grace', () => {
    expect(isWithinMissingItemGrace(inject<Date>(NOW), NOW)).toBe(false);
    expect(isWithinMissingItemGrace(inject<Date>('2026-08-17T23:09:30Z'), NOW)).toBe(false);
  });

  it('treats an Invalid Date as outside grace without throwing', () => {
    expect(isWithinMissingItemGrace(new Date('nonsense'), NOW)).toBe(false);
  });

  // Clock skew yields a negative age. Accepted: it self-clears once wall time passes the window.
  it('treats a future-dated addedAt as within grace', () => {
    expect(isWithinMissingItemGrace(new Date(NOW + 60_000), NOW)).toBe(true);
  });
});

describe('MISSING_ITEM_GRACE_MS', () => {
  it('is exactly two minutes', () => {
    expect(MISSING_ITEM_GRACE_MS).toBe(120_000);
  });

  // The observed #2423 incident failed on the first poll, 28s after the add.
  it('spans at least four polls at the default 30-second monitor tick', () => {
    expect(MISSING_ITEM_GRACE_MS).toBeGreaterThanOrEqual(4 * 30_000);
  });
});
