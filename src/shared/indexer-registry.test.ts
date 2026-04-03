import { describe, it, expect } from 'vitest';
import { INDEXER_REGISTRY, MAM_LANGUAGES, MAM_SEARCH_TYPES } from './indexer-registry.js';
import { indexerTypeSchema } from './schemas/indexer.js';

describe('INDEXER_REGISTRY', () => {
  const types = indexerTypeSchema.options;

  describe('invariants', () => {
    it('has an entry for every indexer type in the Zod enum', () => {
      for (const type of types) {
        expect(INDEXER_REGISTRY[type], `Missing registry entry for type: ${type}`).toBeDefined();
      }
    });

    it('every entry has label, defaultSettings, requiredFields, and viewSubtitle', () => {
      for (const type of types) {
        const meta = INDEXER_REGISTRY[type];
        expect(meta.label).toBeTypeOf('string');
        expect(meta.defaultSettings).toBeDefined();
        expect(Array.isArray(meta.requiredFields)).toBe(true);
        expect(meta.viewSubtitle).toBeTypeOf('function');
      }
    });

    it('requiredFields paths are valid setting field names', () => {
      for (const type of types) {
        const meta = INDEXER_REGISTRY[type];
        for (const field of meta.requiredFields) {
          expect(field.path).toBeTypeOf('string');
          expect(field.message).toBeTypeOf('string');
        }
      }
    });
  });

  describe('viewSubtitle', () => {
    it('returns hostname for abb type', () => {
      expect(INDEXER_REGISTRY.abb.viewSubtitle({ hostname: 'example.com' })).toBe('example.com');
    });

    it('returns apiUrl for torznab type', () => {
      expect(INDEXER_REGISTRY.torznab.viewSubtitle({ apiUrl: 'https://tracker.test/api' })).toBe('https://tracker.test/api');
    });

    it('returns apiUrl for newznab type', () => {
      expect(INDEXER_REGISTRY.newznab.viewSubtitle({ apiUrl: 'https://nzb.test/api' })).toBe('https://nzb.test/api');
    });

    it('returns type label as fallback when settings fields are missing', () => {
      expect(INDEXER_REGISTRY.abb.viewSubtitle({})).toBe('abb');
      expect(INDEXER_REGISTRY.torznab.viewSubtitle({})).toBe('torznab');
      expect(INDEXER_REGISTRY.newznab.viewSubtitle({})).toBe('newznab');
      expect(INDEXER_REGISTRY.myanonamouse.viewSubtitle({})).toBe('myanonamouse.net');
    });

    it('returns baseUrl for myanonamouse type', () => {
      expect(INDEXER_REGISTRY.myanonamouse.viewSubtitle({ baseUrl: 'https://custom.mam.net' })).toBe('https://custom.mam.net');
    });

    it('#317 returns baseUrl with VIP suffix when isVip is true', () => {
      expect(INDEXER_REGISTRY.myanonamouse.viewSubtitle({ isVip: true })).toBe('myanonamouse.net — VIP');
      expect(INDEXER_REGISTRY.myanonamouse.viewSubtitle({ baseUrl: 'https://custom.mam.net', isVip: true })).toBe('https://custom.mam.net — VIP');
    });

    it('#317 returns baseUrl with User suffix when isVip is false', () => {
      expect(INDEXER_REGISTRY.myanonamouse.viewSubtitle({ isVip: false })).toBe('myanonamouse.net — User');
    });

    it('#317 returns baseUrl without suffix when isVip is undefined (legacy)', () => {
      expect(INDEXER_REGISTRY.myanonamouse.viewSubtitle({})).toBe('myanonamouse.net');
    });
  });

  describe('defaultSettings', () => {
    it('abb defaults include hostname, pageLimit, flareSolverrUrl', () => {
      const defaults = INDEXER_REGISTRY.abb.defaultSettings;
      expect(defaults).toHaveProperty('hostname');
      expect(defaults).toHaveProperty('pageLimit');
      expect(defaults).toHaveProperty('flareSolverrUrl');
    });

    it('torznab defaults include apiUrl, apiKey, flareSolverrUrl', () => {
      const defaults = INDEXER_REGISTRY.torznab.defaultSettings;
      expect(defaults).toHaveProperty('apiUrl');
      expect(defaults).toHaveProperty('apiKey');
      expect(defaults).toHaveProperty('flareSolverrUrl');
    });

    it('newznab defaults include apiUrl, apiKey, flareSolverrUrl', () => {
      const defaults = INDEXER_REGISTRY.newznab.defaultSettings;
      expect(defaults).toHaveProperty('apiUrl');
      expect(defaults).toHaveProperty('apiKey');
      expect(defaults).toHaveProperty('flareSolverrUrl');
    });

    it('myanonamouse defaults include mamId and baseUrl', () => {
      const defaults = INDEXER_REGISTRY.myanonamouse.defaultSettings;
      expect(defaults).toHaveProperty('mamId');
      expect(defaults).toHaveProperty('baseUrl');
    });

    it('myanonamouse defaults include searchLanguages: [1] and searchType: 1', () => {
      const defaults = INDEXER_REGISTRY.myanonamouse.defaultSettings;
      expect(defaults).toHaveProperty('searchLanguages', [1]);
      expect(defaults).toHaveProperty('searchType', 1);
    });
  });

  describe('MAM_LANGUAGES and MAM_SEARCH_TYPES constants', () => {
    it('MAM_LANGUAGES contains exactly 15 languages with id and label', () => {
      expect(MAM_LANGUAGES).toHaveLength(15);
      for (const lang of MAM_LANGUAGES) {
        expect(lang).toHaveProperty('id');
        expect(lang).toHaveProperty('label');
        expect(typeof lang.id).toBe('number');
        expect(typeof lang.label).toBe('string');
      }
      // Verify English is present
      expect(MAM_LANGUAGES.find(l => l.id === 1)?.label).toBe('English');
    });

    it('MAM_SEARCH_TYPES contains 4 options with value and label', () => {
      expect(MAM_SEARCH_TYPES).toHaveLength(4);
      for (const st of MAM_SEARCH_TYPES) {
        expect(st).toHaveProperty('value');
        expect(st).toHaveProperty('label');
        expect(typeof st.value).toBe('number');
        expect(typeof st.label).toBe('string');
      }
      // Verify specific values
      expect(MAM_SEARCH_TYPES.map(s => s.value)).toEqual([0, 1, 2, 3]);
    });
  });
});
