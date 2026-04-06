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

    it('webhook defaultSettings includes headers and bodyTemplate', () => {
      const defaults = NOTIFIER_REGISTRY.webhook.defaultSettings as Record<string, unknown>;
      expect(defaults).toHaveProperty('headers', '');
      expect(defaults).toHaveProperty('bodyTemplate', '');
    });

    it('email defaultSettings includes smtpUser and smtpPass', () => {
      const defaults = NOTIFIER_REGISTRY.email.defaultSettings as Record<string, unknown>;
      expect(defaults).toHaveProperty('smtpUser', '');
      expect(defaults).toHaveProperty('smtpPass', '');
    });

    it('ntfy defaultSettings includes ntfyServer', () => {
      const defaults = NOTIFIER_REGISTRY.ntfy.defaultSettings as Record<string, unknown>;
      expect(defaults).toHaveProperty('ntfyServer', '');
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
