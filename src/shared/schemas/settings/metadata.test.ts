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
});
