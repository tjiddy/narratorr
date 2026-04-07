import { describe, expect, it } from 'vitest';
import { CANONICAL_LANGUAGES } from './language-constants.js';

describe('CANONICAL_LANGUAGES', () => {
  it('exports a non-empty readonly array of lowercase language names', () => {
    expect(CANONICAL_LANGUAGES.length).toBeGreaterThan(0);
    for (const lang of CANONICAL_LANGUAGES) {
      expect(typeof lang).toBe('string');
      expect(lang).toBe(lang.toLowerCase());
    }
  });

  it('is alphabetically sorted', () => {
    const sorted = [...CANONICAL_LANGUAGES].sort();
    expect(CANONICAL_LANGUAGES).toEqual(sorted);
  });

  it('includes english as a valid entry', () => {
    expect(CANONICAL_LANGUAGES).toContain('english');
  });

  it('all entries are lowercase strings', () => {
    for (const lang of CANONICAL_LANGUAGES) {
      expect(lang).toMatch(/^[a-z]+$/);
    }
  });
});
