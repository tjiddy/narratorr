import { describe, it, expect } from 'vitest';
import { calculateQuality, qualityTierBg, qualityTierColor } from './quality.js';

describe('calculateQuality', () => {
  it('returns null for zero duration', () => {
    expect(calculateQuality(1000000, 0)).toBeNull();
  });

  it('returns null for zero size', () => {
    expect(calculateQuality(0, 3600)).toBeNull();
  });

  it('returns null for negative duration', () => {
    expect(calculateQuality(1000000, -100)).toBeNull();
  });

  it('calculates Low tier (< 30 MB/hr)', () => {
    // 10 MB over 1 hour = 10 MB/hr
    const result = calculateQuality(10 * 1024 * 1024, 3600);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('Low');
    expect(result!.mbPerHour).toBe(10);
  });

  it('calculates Fair tier (30-80 MB/hr)', () => {
    // 50 MB over 1 hour = 50 MB/hr
    const result = calculateQuality(50 * 1024 * 1024, 3600);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('Fair');
    expect(result!.mbPerHour).toBe(50);
  });

  it('calculates Good tier (80-200 MB/hr)', () => {
    // 128 MB over 1 hour = 128 MB/hr
    const result = calculateQuality(128 * 1024 * 1024, 3600);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('Good');
    expect(result!.mbPerHour).toBe(128);
  });

  it('calculates High tier (200-400 MB/hr)', () => {
    // 300 MB over 1 hour = 300 MB/hr
    const result = calculateQuality(300 * 1024 * 1024, 3600);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('High');
    expect(result!.mbPerHour).toBe(300);
  });

  it('calculates Lossless tier (> 400 MB/hr)', () => {
    // 500 MB over 1 hour = 500 MB/hr
    const result = calculateQuality(500 * 1024 * 1024, 3600);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('Lossless');
    expect(result!.mbPerHour).toBe(500);
  });

  it('handles multi-hour durations', () => {
    // 1280 MB over 10 hours = 128 MB/hr
    const result = calculateQuality(1280 * 1024 * 1024, 36000);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('Good');
    expect(result!.mbPerHour).toBe(128);
  });

  it('rounds mbPerHour to nearest integer', () => {
    // 33.33 MB over 1 hour
    const bytes = 33.33 * 1024 * 1024;
    const result = calculateQuality(bytes, 3600);
    expect(result).not.toBeNull();
    expect(result!.mbPerHour).toBe(33);
  });

  // Boundary tests
  it('returns Fair at exactly 30 MB/hr', () => {
    const result = calculateQuality(30 * 1024 * 1024, 3600);
    expect(result!.tier).toBe('Fair');
  });

  it('returns Good at exactly 80 MB/hr', () => {
    const result = calculateQuality(80 * 1024 * 1024, 3600);
    expect(result!.tier).toBe('Good');
  });

  it('returns High at exactly 200 MB/hr', () => {
    const result = calculateQuality(200 * 1024 * 1024, 3600);
    expect(result!.tier).toBe('High');
  });

  it('returns Lossless at exactly 400 MB/hr', () => {
    const result = calculateQuality(400 * 1024 * 1024, 3600);
    expect(result!.tier).toBe('Lossless');
  });
});

describe('qualityTierColor', () => {
  it('returns correct color for each tier', () => {
    expect(qualityTierColor('Low')).toContain('red');
    expect(qualityTierColor('Fair')).toContain('yellow');
    expect(qualityTierColor('Good')).toContain('green');
    expect(qualityTierColor('High')).toContain('blue');
    expect(qualityTierColor('Lossless')).toContain('purple');
  });
});

describe('qualityTierBg', () => {
  it('returns background classes for each tier', () => {
    expect(qualityTierBg('Low')).toContain('bg-red');
    expect(qualityTierBg('Fair')).toContain('bg-yellow');
    expect(qualityTierBg('Good')).toContain('bg-green');
    expect(qualityTierBg('High')).toContain('bg-blue');
    expect(qualityTierBg('Lossless')).toContain('bg-purple');
  });
});
