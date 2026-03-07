import { describe, it, expect } from 'vitest';
import { formatBytes, formatProgress } from '@/lib/api';

describe('formatBytes', () => {
  it('returns 0 B for undefined', () => {
    expect(formatBytes(undefined)).toBe('0 B');
  });

  it('returns 0 B for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });

  it('formats fractional values', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('formatProgress', () => {
  it('formats 0%', () => {
    expect(formatProgress(0)).toBe('0%');
  });

  it('formats 100%', () => {
    expect(formatProgress(1)).toBe('100%');
  });

  it('formats partial progress', () => {
    expect(formatProgress(0.5)).toBe('50%');
  });

  it('rounds fractional percentages', () => {
    expect(formatProgress(0.333)).toBe('33%');
  });

  it('rounds up when >= 0.5', () => {
    expect(formatProgress(0.666)).toBe('67%');
  });
});
