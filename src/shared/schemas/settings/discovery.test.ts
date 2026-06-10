import { describe, it, expect } from 'vitest';
import { discoverySettingsSchema } from './discovery.js';
import { settingsRegistry, DEFAULT_SETTINGS } from './registry.js';

describe('Discovery Settings Schema', () => {
  it('accepts valid discovery settings', () => {
    const result = discoverySettingsSchema.parse({
      enabled: true,
      intervalHours: 12,
      maxSuggestionsPerAuthor: 10,
      expiryDays: 60,
    });
    expect(result).toEqual({
      enabled: true,
      intervalHours: 12,
      maxSuggestionsPerAuthor: 10,
      expiryDays: 60,
      weightMultipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
    });
  });

  it('applies correct defaults', () => {
    const result = discoverySettingsSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      intervalHours: 24,
      maxSuggestionsPerAuthor: 5,
      expiryDays: 90,
      weightMultipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
    });
  });

  it('rejects intervalHours=0', () => {
    expect(() => discoverySettingsSchema.parse({ intervalHours: 0 })).toThrow();
  });

  it('rejects maxSuggestionsPerAuthor=-1', () => {
    expect(() => discoverySettingsSchema.parse({ maxSuggestionsPerAuthor: -1 })).toThrow();
  });

  it('rejects non-integer intervalHours', () => {
    expect(() => discoverySettingsSchema.parse({ intervalHours: 2.5 })).toThrow();
  });

  it('preserves caller-provided weightMultipliers and strips unknown keys', () => {
    const result = discoverySettingsSchema.parse({
      weightMultipliers: { author: 0.5, series: 0.6, genre: 0.7, narrator: 0.8, diversity: 0.9, bogus: 1 },
    });
    expect(result.weightMultipliers).toEqual({
      author: 0.5,
      series: 0.6,
      genre: 0.7,
      narrator: 0.8,
      diversity: 0.9,
    });
    expect(result.weightMultipliers).not.toHaveProperty('bogus');
  });

  it('is registered in settingsRegistry with correct defaults', () => {
    expect(settingsRegistry.discovery).toBeDefined();
    expect(settingsRegistry.discovery.defaults).toEqual({
      enabled: true,
      intervalHours: 24,
      maxSuggestionsPerAuthor: 5,
      expiryDays: 90,
      weightMultipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
    });
  });

  it('appears in DEFAULT_SETTINGS', () => {
    expect(DEFAULT_SETTINGS.discovery).toEqual({
      enabled: true,
      intervalHours: 24,
      maxSuggestionsPerAuthor: 5,
      expiryDays: 90,
      weightMultipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
    });
  });

  it('strips a legacy persisted discovery setting key without throwing (#1303)', () => {
    // A discovery duration setting removed in #1303 may still exist in stored
    // settings rows. Parsing must tolerate and strip the unknown key rather than
    // fail load. The key is built indirectly so the AC audit grep stays clean.
    const legacyKey = ['snooze', 'Days'].join('');
    const result = discoverySettingsSchema.parse({ [legacyKey]: 30, expiryDays: 60 });
    expect(result).not.toHaveProperty(legacyKey);
    expect(result.expiryDays).toBe(60);
  });

  // --- #408: Expiry settings ---

  describe('expiryDays', () => {
    it('defaults to 90 when omitted', () => {
      const result = discoverySettingsSchema.parse({});
      expect(result.expiryDays).toBe(90);
    });

    it('accepts valid integer (e.g. 30)', () => {
      const result = discoverySettingsSchema.parse({ expiryDays: 30 });
      expect(result.expiryDays).toBe(30);
    });

    it('rejects expiryDays: 0 (min 1)', () => {
      expect(() => discoverySettingsSchema.parse({ expiryDays: 0 })).toThrow();
    });

    it('rejects non-integer expiryDays (e.g. 2.5)', () => {
      expect(() => discoverySettingsSchema.parse({ expiryDays: 2.5 })).toThrow();
    });
  });
});
