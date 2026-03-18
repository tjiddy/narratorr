import { describe, it, expect } from 'vitest';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES } from './import-list-registry.js';
import { importListTypeSchema } from './schemas/import-list.js';

describe('IMPORT_LIST_REGISTRY', () => {
  const types = importListTypeSchema.options;

  describe('schema-registry alignment', () => {
    it('has an entry for every importListTypeSchema value', () => {
      for (const type of types) {
        expect(IMPORT_LIST_REGISTRY[type], `Missing registry entry for type: ${type}`).toBeDefined();
      }
    });

    it('registry keys exactly match importListTypeSchema.options', () => {
      const registryKeys = Object.keys(IMPORT_LIST_REGISTRY).sort();
      expect(registryKeys).toEqual([...types].sort());
    });

    it('IMPORT_LIST_TYPES tuple matches importListTypeSchema.options', () => {
      expect([...IMPORT_LIST_TYPES].sort()).toEqual([...types].sort());
    });
  });

  describe('metadata completeness', () => {
    it('every entry has label, defaultSettings, requiredFields, and viewSubtitle', () => {
      for (const type of types) {
        const meta = IMPORT_LIST_REGISTRY[type];
        expect(meta.label).toBeTypeOf('string');
        expect(meta.defaultSettings).toBeDefined();
        expect(Array.isArray(meta.requiredFields)).toBe(true);
        expect(meta.viewSubtitle).toBeTypeOf('function');
      }
    });

    it('requiredFields paths are valid setting field names', () => {
      for (const type of types) {
        const meta = IMPORT_LIST_REGISTRY[type];
        for (const field of meta.requiredFields) {
          expect(field.path).toBeTypeOf('string');
          expect(field.message).toBeTypeOf('string');
        }
      }
    });
  });
});
