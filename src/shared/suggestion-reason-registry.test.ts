import { describe, it, expect } from 'vitest';
import {
  suggestionReasonSchema,
  SUGGESTION_REASONS,
  SUGGESTION_REASON_REGISTRY,
  type SuggestionReason,
} from './schemas.js';

describe('suggestion-reason-registry', () => {
  describe('schema ↔ registry parity', () => {
    it('every schema value has a corresponding registry entry', () => {
      for (const reason of suggestionReasonSchema.options) {
        expect(SUGGESTION_REASON_REGISTRY[reason]).toBeDefined();
      }
    });

    it('every registry key is a valid schema value (no orphan entries)', () => {
      const registryKeys = Object.keys(SUGGESTION_REASON_REGISTRY) as string[];
      for (const key of registryKeys) {
        expect(suggestionReasonSchema.safeParse(key).success).toBe(true);
      }
    });

    it('registry entries have required metadata fields (label)', () => {
      for (const reason of suggestionReasonSchema.options) {
        const entry = SUGGESTION_REASON_REGISTRY[reason];
        expect(entry.label).toBeTypeOf('string');
        expect(entry.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('schema values', () => {
    it('schema contains exactly the 5 known reason values', () => {
      const expected: SuggestionReason[] = ['author', 'series', 'genre', 'narrator', 'diversity'];
      expect([...suggestionReasonSchema.options]).toEqual(expected);
    });

    it('schema rejects an unknown value', () => {
      expect(suggestionReasonSchema.safeParse('bogus').success).toBe(false);
    });
  });

  describe('SUGGESTION_REASONS array', () => {
    it('exports an array of all reason values derived from schema', () => {
      expect(SUGGESTION_REASONS).toEqual(suggestionReasonSchema.options);
    });
  });
});
