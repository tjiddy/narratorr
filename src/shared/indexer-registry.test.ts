import { describe, it, expect } from 'vitest';
import { INDEXER_REGISTRY } from './indexer-registry.js';
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
  });
});
