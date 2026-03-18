import { describe, it, expect } from 'vitest';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES } from './notifier-registry.js';
import { notifierTypeSchema } from './schemas/notifier.js';

describe('NOTIFIER_REGISTRY', () => {
  const types = notifierTypeSchema.options;

  describe('schema-registry alignment', () => {
    it('has an entry for every notifierTypeSchema value', () => {
      for (const type of types) {
        expect(NOTIFIER_REGISTRY[type], `Missing registry entry for type: ${type}`).toBeDefined();
      }
    });

    it('registry keys exactly match notifierTypeSchema.options', () => {
      const registryKeys = Object.keys(NOTIFIER_REGISTRY).sort();
      expect(registryKeys).toEqual([...types].sort());
    });

    it('NOTIFIER_TYPES tuple matches notifierTypeSchema.options', () => {
      expect([...NOTIFIER_TYPES].sort()).toEqual([...types].sort());
    });
  });

  describe('metadata completeness', () => {
    it('every entry has label, defaultSettings, requiredFields, and viewSubtitle', () => {
      for (const type of types) {
        const meta = NOTIFIER_REGISTRY[type];
        expect(meta.label).toBeTypeOf('string');
        expect(meta.defaultSettings).toBeDefined();
        expect(Array.isArray(meta.requiredFields)).toBe(true);
        expect(meta.viewSubtitle).toBeTypeOf('function');
      }
    });

    it('requiredFields paths are valid setting field names', () => {
      for (const type of types) {
        const meta = NOTIFIER_REGISTRY[type];
        for (const field of meta.requiredFields) {
          expect(field.path).toBeTypeOf('string');
          expect(field.message).toBeTypeOf('string');
        }
      }
    });
  });
});
