import { describe, expect, it } from 'vitest';
import { metadataSettingsSchema } from './metadata.js';

describe('metadataSettingsSchema', () => {
  describe('languages field', () => {
    it('accepts valid CANONICAL_LANGUAGES values', () => {
      const result = metadataSettingsSchema.parse({ languages: ['english', 'spanish'] });
      expect(result.languages).toEqual(['english', 'spanish']);
    });

    it('defaults to [english] when omitted', () => {
      const result = metadataSettingsSchema.parse({});
      expect(result.languages).toEqual(['english']);
    });

    it('rejects values not in CANONICAL_LANGUAGES', () => {
      expect(() => metadataSettingsSchema.parse({ languages: ['klingon'] })).toThrow();
    });

    it('accepts empty array (disables filtering)', () => {
      const result = metadataSettingsSchema.parse({ languages: [] });
      expect(result.languages).toEqual([]);
    });

    it('rejects non-string array elements', () => {
      expect(() => metadataSettingsSchema.parse({ languages: [123] })).toThrow();
    });
  });

  describe('minDurationMinutes field (#987)', () => {
    it('defaults to 0 when omitted', () => {
      const result = metadataSettingsSchema.parse({});
      expect(result.minDurationMinutes).toBe(0);
    });

    it('accepts a positive integer (e.g. recommended threshold of 30)', () => {
      const result = metadataSettingsSchema.parse({ minDurationMinutes: 30 });
      expect(result.minDurationMinutes).toBe(30);
    });

    it('accepts 0 explicitly (filter disabled)', () => {
      const result = metadataSettingsSchema.parse({ minDurationMinutes: 0 });
      expect(result.minDurationMinutes).toBe(0);
    });

    it('rejects negative numbers (nonnegative)', () => {
      expect(() => metadataSettingsSchema.parse({ minDurationMinutes: -1 })).toThrow();
    });

    it('rejects non-integer numbers (int)', () => {
      expect(() => metadataSettingsSchema.parse({ minDurationMinutes: 1.5 })).toThrow();
    });

    it('rejects non-numeric values', () => {
      expect(() => metadataSettingsSchema.parse({ minDurationMinutes: '30' })).toThrow();
    });
  });
});
