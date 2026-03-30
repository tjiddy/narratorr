import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDate, formatRelativeDate } from './format';

describe('formatDate', () => {
  it('returns locale-formatted absolute date string for valid ISO input', () => {
    const result = formatDate('2026-01-15T00:00:00Z');
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

  it('falls back to absolute date for timestamps 8+ days ago', () => {
    setNow(NOW);
    const result = formatRelativeDate('2026-03-20T12:00:00Z');
    // Should be locale date, not relative
    expect(result).not.toContain('ago');
    expect(result).not.toBe('Just now');
  });

  it('boundary: exactly 60 minutes returns "1h ago" not "60m ago"', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-30T11:00:00Z')).toBe('1h ago');
  });

  it('boundary: exactly 24 hours returns "1d ago" not "24h ago"', () => {
    setNow(NOW);
    expect(formatRelativeDate('2026-03-29T12:00:00Z')).toBe('1d ago');
  });

  it('boundary: exactly 7 days falls back to absolute date not "7d ago"', () => {
    setNow(NOW);
    const result = formatRelativeDate('2026-03-23T12:00:00Z');
    expect(result).not.toContain('ago');
    expect(result).not.toBe('Just now');
  });
});
