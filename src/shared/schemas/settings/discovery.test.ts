import { describe, it, expect } from 'vitest';
import { discoverySettingsSchema } from './discovery.js';
import { settingsRegistry, DEFAULT_SETTINGS } from './registry.js';

describe('Discovery Settings Schema', () => {
  it('accepts valid discovery settings', () => {
    const result = discoverySettingsSchema.parse({
      enabled: true,
      intervalHours: 12,
      maxSuggestionsPerAuthor: 10,
    });
    expect(result).toEqual({
      enabled: true,
      intervalHours: 12,
      maxSuggestionsPerAuthor: 10,
    });
  });

  it('applies correct defaults (enabled=false, intervalHours=24, maxSuggestionsPerAuthor=5)', () => {
    const result = discoverySettingsSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      intervalHours: 24,
      maxSuggestionsPerAuthor: 5,
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

  it('is registered in settingsRegistry with correct defaults', () => {
    expect(settingsRegistry.discovery).toBeDefined();
    expect(settingsRegistry.discovery.defaults).toEqual({
      enabled: false,
      intervalHours: 24,
      maxSuggestionsPerAuthor: 5,
    });
  });

  it('appears in DEFAULT_SETTINGS', () => {
    expect(DEFAULT_SETTINGS.discovery).toEqual({
      enabled: false,
      intervalHours: 24,
      maxSuggestionsPerAuthor: 5,
    });
  });
});
