import { describe, it, expect } from 'vitest';
import { calculateQuality, compareQuality, resolveBookQualityInputs, qualityTierBg, qualityTierColor } from './quality.js';

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

describe('compareQuality', () => {
  const MB = 1024 * 1024;
  const HOUR = 3600;

  it('returns lower when result MB/hr < existing', () => {
    // existing: 128 MB/hr, result: 50 MB/hr
    expect(compareQuality(128 * MB, 50 * MB, HOUR)).toBe('lower');
  });

  it('returns higher when result MB/hr > existing', () => {
    // existing: 50 MB/hr, result: 128 MB/hr
    expect(compareQuality(50 * MB, 128 * MB, HOUR)).toBe('higher');
  });

  it('returns similar when within ±10% threshold', () => {
    // existing: 100 MB/hr, result: 105 MB/hr (5% higher → similar)
    expect(compareQuality(100 * MB, 105 * MB, HOUR)).toBe('similar');
  });

  it('returns null when existing size is 0', () => {
    expect(compareQuality(0, 100 * MB, HOUR)).toBeNull();
  });

  it('returns null when result size is 0', () => {
    expect(compareQuality(100 * MB, 0, HOUR)).toBeNull();
  });

  it('returns null when duration is 0', () => {
    expect(compareQuality(100 * MB, 50 * MB, 0)).toBeNull();
  });

  it('returns null when existing size is null', () => {
    expect(compareQuality(null, 100 * MB, HOUR)).toBeNull();
  });

  it('returns null when result size is undefined', () => {
    expect(compareQuality(100 * MB, undefined, HOUR)).toBeNull();
  });

  it('returns null when duration is null', () => {
    expect(compareQuality(100 * MB, 50 * MB, null)).toBeNull();
  });

  it('respects custom threshold', () => {
    // existing: 100 MB/hr, result: 85 MB/hr (15% lower)
    // Default threshold (10%) → lower
    expect(compareQuality(100 * MB, 85 * MB, HOUR, 0.1)).toBe('lower');
    // Threshold 20% → similar
    expect(compareQuality(100 * MB, 85 * MB, HOUR, 0.2)).toBe('similar');
  });
});

describe('resolveBookQualityInputs', () => {
  it('uses audioTotalSize when present, falls back to size', () => {
    const result = resolveBookQualityInputs({ audioTotalSize: 500, size: 300 });
    expect(result.sizeBytes).toBe(500);
  });

  it('falls back to size when audioTotalSize is null', () => {
    const result = resolveBookQualityInputs({ audioTotalSize: null, size: 300 });
    expect(result.sizeBytes).toBe(300);
  });

  it('uses audioDuration when present, falls back to duration * 60', () => {
    const result = resolveBookQualityInputs({ audioDuration: 7200, duration: 150 });
    expect(result.durationSeconds).toBe(7200);
  });

  it('falls back to duration * 60 when audioDuration is null', () => {
    const result = resolveBookQualityInputs({ audioDuration: null, duration: 120 });
    expect(result.durationSeconds).toBe(7200); // 120 * 60
  });

  it('returns null when both audioTotalSize and size are null', () => {
    const result = resolveBookQualityInputs({ audioTotalSize: null, size: null });
    expect(result.sizeBytes).toBeNull();
  });

  it('returns null when both audioDuration and duration are null', () => {
    const result = resolveBookQualityInputs({ audioDuration: null, duration: null });
    expect(result.durationSeconds).toBeNull();
  });

  it('returns null when resolved size is 0', () => {
    const result = resolveBookQualityInputs({ audioTotalSize: 0, size: 0 });
    expect(result.sizeBytes).toBeNull();
  });

  it('returns null when resolved duration is 0', () => {
    const result = resolveBookQualityInputs({ audioDuration: 0, duration: 0 });
    expect(result.durationSeconds).toBeNull();
  });

  it('skips audioTotalSize when 0, uses size fallback', () => {
    const result = resolveBookQualityInputs({ audioTotalSize: 0, size: 500 });
    expect(result.sizeBytes).toBe(500);
  });

  it('skips audioDuration when 0, uses duration fallback', () => {
    const result = resolveBookQualityInputs({ audioDuration: 0, duration: 120 });
    expect(result.durationSeconds).toBe(7200);
  });
});
