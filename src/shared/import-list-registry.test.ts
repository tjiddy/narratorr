import { describe, it, expect, expectTypeOf } from 'vitest';
import { IMPORT_LIST_REGISTRY, IMPORT_LIST_TYPES, type ImportListType, type ImportListTypeMetadata } from './import-list-registry.js';
import { importListTypeSchema } from './schemas/import-list.js';

describe('IMPORT_LIST_REGISTRY', () => {
  const types = importListTypeSchema.options;

  describe('type narrowing', () => {
    it('keys are narrowed to ImportListType — no string index signature', () => {
      expectTypeOf<keyof typeof IMPORT_LIST_REGISTRY>().toEqualTypeOf<ImportListType>();
    });

    it('each entry is structurally an ImportListTypeMetadata', () => {
      expectTypeOf<(typeof IMPORT_LIST_REGISTRY)[ImportListType]>().toExtend<ImportListTypeMetadata>();
    });

    it('indexing with a non-ImportListType key is a type error', () => {
      // @ts-expect-error — 'unknown' is not in ImportListType
      IMPORT_LIST_REGISTRY['unknown'];
    });
  });

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

  describe('viewSubtitle fallback branches', () => {
    it('abs viewSubtitle returns abs when serverUrl is empty', () => {
      expect(IMPORT_LIST_REGISTRY.abs.viewSubtitle({ serverUrl: '' })).toBe('abs');
    });

    it('abs viewSubtitle returns serverUrl when populated', () => {
      expect(IMPORT_LIST_REGISTRY.abs.viewSubtitle({ serverUrl: 'http://my-abs.local' })).toBe('http://my-abs.local');
    });

    it('nyt viewSubtitle returns audio-fiction when list is empty', () => {
      expect(IMPORT_LIST_REGISTRY.nyt.viewSubtitle({ list: '' })).toBe('audio-fiction');
    });

    it('nyt viewSubtitle returns list value when populated', () => {
      expect(IMPORT_LIST_REGISTRY.nyt.viewSubtitle({ list: 'audio-nonfiction' })).toBe('audio-nonfiction');
    });

    it('hardcover viewSubtitle returns trending when listType is empty', () => {
      expect(IMPORT_LIST_REGISTRY.hardcover.viewSubtitle({ listType: '' })).toBe('trending');
    });

    it('hardcover viewSubtitle returns listType value when populated', () => {
      expect(IMPORT_LIST_REGISTRY.hardcover.viewSubtitle({ listType: 'shelf' })).toBe('shelf');
    });
  });
});
