import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDate, formatRelativeDate, formatDurationMinutes, formatDurationSeconds, formatChannels } from './format';

describe('formatDate', () => {
  it('returns locale-formatted absolute date string for valid ISO input', () => {
    // Use midday UTC to avoid timezone-shift flipping the date to the previous day
    const result = formatDate('2026-01-15T12:00:00Z');
    // toLocaleDateString with year/month/day produces locale-dependent output
    // Verify it contains the key date parts
    expect(result).toContain('2026');
    expect(result).toContain('15');
  });

  it('returns "Invalid Date" for invalid date string input', () => {
    expect(formatDate('not-a-date')).toBe('Invalid Date');
  });

  it('handles ISO string with timezone offset', () => {
    const result = formatDate('2026-06-20T14:30:00+05:00');
    expect(result).toContain('2026');
  });
});

describe('formatRelativeDate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setNow(isoString: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(isoString));
  }

  const NOW = '2026-03-30T12:00:00Z';

  it('returns "Invalid Date" for invalid date string input', () => {
    expect(formatRelativeDate('not-a-date')).toBe('Invalid Date');
  });

  it('returns "Just now" for timestamps less than 1 minute ago', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-30T11:59:30Z')).toBe('Just now');
  });

  it('returns "5m ago" for timestamps 5 minutes ago', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-30T11:55:00Z')).toBe('5m ago');
  });

  it('returns "3h ago" for timestamps 3 hours ago', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-30T09:00:00Z')).toBe('3h ago');
  });

  it('returns "2d ago" for timestamps 2 days ago', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-28T12:00:00Z')).toBe('2d ago');
  });

  it('falls back to month-day format for timestamps 8+ days ago', () => {
    setNow(NOW);
    const result = formatRelativeDate('2026-03-20T12:00:00Z');
    expect(result).toBe('Mar 20');
  });

  it('boundary: exactly 60 minutes returns "1h ago" not "60m ago"', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-30T11:00:00Z')).toBe('1h ago');
  });

  it('boundary: exactly 24 hours returns "1d ago" not "24h ago"', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-29T12:00:00Z')).toBe('1d ago');
  });

  it('boundary: exactly 7 days falls back to month-day format not "7d ago"', () => {
    setNow(NOW);
    const result = formatRelativeDate('2026-03-23T12:00:00Z');
    expect(result).toBe('Mar 23');
  });
});

describe('formatDurationMinutes', () => {
  it('formats hours and minutes together', () => {
    expect(formatDurationMinutes(90)).toBe('1h 30m');
    expect(formatDurationMinutes(61)).toBe('1h 1m');
  });

  it('formats minutes only when under 60', () => {
    expect(formatDurationMinutes(45)).toBe('45m');
  });

  it('formats hours only when evenly divisible by 60', () => {
    expect(formatDurationMinutes(120)).toBe('2h');
  });

  it('returns null for 0 (falsy)', () => {
    expect(formatDurationMinutes(0)).toBeNull();
  });

  it('returns "1h" for exactly 60 minutes', () => {
    expect(formatDurationMinutes(60)).toBe('1h');
  });

  it('returns "1m" for minimum non-zero', () => {
    expect(formatDurationMinutes(1)).toBe('1m');
  });

  it('returns null for null', () => {
    expect(formatDurationMinutes(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(formatDurationMinutes(undefined)).toBeNull();
  });

  it('returns null when called with no arguments', () => {
    expect(formatDurationMinutes()).toBeNull();
  });
});

describe('formatDurationSeconds', () => {
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

    it('returns "0h 0m" for sub-minute seconds', () => {
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

  it('returns empty string for null with no fallback', () => {
    expect(formatDurationSeconds(null)).toBe('');
  });

  it('returns custom fallback string for null', () => {
    expect(formatDurationSeconds(null, { fallback: '—' })).toBe('—');
  });
});

describe('formatChannels', () => {
  it('returns "Mono" for 1 channel', () => {
    expect(formatChannels(1)).toBe('Mono');
  });

  it('returns "Stereo" for 2 channels', () => {
    expect(formatChannels(2)).toBe('Stereo');
  });

  it('returns numeric format with "ch" suffix for surround', () => {
    expect(formatChannels(6)).toBe('6ch');
    expect(formatChannels(8)).toBe('8ch');
  });

  it('returns "0ch" for 0 channels', () => {
    expect(formatChannels(0)).toBe('0ch');
  });

  it('returns empty string for null with no fallback', () => {
    expect(formatChannels(null)).toBe('');
  });

  it('returns custom fallback string for null', () => {
    expect(formatChannels(null, '—')).toBe('—');
  });
});
