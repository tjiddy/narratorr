import { describe, it, expect } from 'vitest';
import { formatDurationSeconds } from './format-duration.js';

// Moved here from the client `format.test.ts` and the server
// `match-job.helpers.test.ts` (#1854): the formatter now has one shared home, so
// its exact-string, options, fallback/nullish, and >90s-gap regression cases live
// beside the implementation.
describe('formatDurationSeconds (#1854 shared home)', () => {
  describe('alwaysShowBoth: true (default)', () => {
    it('formats standard hours and minutes', () => {
      expect(formatDurationSeconds(5400)).toBe('1h 30m');
      expect(formatDurationSeconds(7260)).toBe('2h 1m');
    });

    it('always shows both parts for sub-hour values', () => {
      expect(formatDurationSeconds(2700)).toBe('0h 45m');
    });

    it('formats hours with zero minutes', () => {
      expect(formatDurationSeconds(3600)).toBe('1h 0m');
    });

    it('returns "0h 0m" for zero seconds', () => {
      expect(formatDurationSeconds(0)).toBe('0h 0m');
    });

    it('floors sub-minute seconds to "0h 0m"', () => {
      expect(formatDurationSeconds(59)).toBe('0h 0m');
    });

    it('returns "0h 1m" for exactly 60 seconds', () => {
      expect(formatDurationSeconds(60)).toBe('0h 1m');
    });
  });

  describe('alwaysShowBoth: false (elides zero parts)', () => {
    it('formats standard hours and minutes', () => {
      expect(formatDurationSeconds(5400, { alwaysShowBoth: false })).toBe('1h 30m');
    });

    it('elides zero hours for sub-hour values', () => {
      expect(formatDurationSeconds(2700, { alwaysShowBoth: false })).toBe('45m');
    });

    it('elides zero minutes for exact hours', () => {
      expect(formatDurationSeconds(3600, { alwaysShowBoth: false })).toBe('1h');
    });

    it('elides zero hours for exactly 1 minute', () => {
      expect(formatDurationSeconds(60, { alwaysShowBoth: false })).toBe('1m');
    });
  });

  describe('nullish handling and fallback', () => {
    it('returns empty string for null with no fallback', () => {
      expect(formatDurationSeconds(null)).toBe('');
    });

    it('returns custom fallback string for null', () => {
      expect(formatDurationSeconds(null, { fallback: '—' })).toBe('—');
    });

    it('accepts undefined and returns fallback', () => {
      expect(formatDurationSeconds(undefined)).toBe('');
      expect(formatDurationSeconds(undefined, { fallback: '—' })).toBe('—');
    });

    it('formatDurationSeconds(0) returns a valid duration string (not the falsy shortcut)', () => {
      expect(formatDurationSeconds(0)).toBe('0h 0m');
    });
  });

  // Floor semantic + the >90s-gap regression (#1850/#1854): two runtimes more than
  // 90s apart can never floor into the same whole minute, so a mismatch reason
  // built from this formatter always renders visibly-distinct sides. Under the old
  // one-decimal-hours display BOTH sides could render "29.8hrs".
  describe('>90s-gap-never-renders-equal regression', () => {
    it('two values >90s apart never floor to the same whole minute', () => {
      // 107340s → 29h 49m; 107440s → 29h 50m (Δ100s). Distinct.
      expect(formatDurationSeconds(107340)).toBe('29h 49m');
      expect(formatDurationSeconds(107440)).toBe('29h 50m');
      expect(formatDurationSeconds(107340)).not.toBe(formatDurationSeconds(107440));
    });
  });
});
