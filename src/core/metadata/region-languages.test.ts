import { describe, it, expect } from 'vitest';
import { REGION_LANGUAGES } from './region-languages.js';

describe('REGION_LANGUAGES', () => {
  it('exports a mapping for all 10 Audible regions', () => {
    const regions = ['us', 'ca', 'uk', 'au', 'in', 'fr', 'de', 'jp', 'it', 'es'];
    for (const region of regions) {
      expect(REGION_LANGUAGES[region]).toBeDefined();
    }
    expect(Object.keys(REGION_LANGUAGES)).toHaveLength(10);
  });

  it('maps us to english', () => {
    expect(REGION_LANGUAGES.us).toBe('english');
  });

  it('maps fr to french', () => {
    expect(REGION_LANGUAGES.fr).toBe('french');
  });

  it('maps de to german', () => {
    expect(REGION_LANGUAGES.de).toBe('german');
  });

  it('maps jp to japanese', () => {
    expect(REGION_LANGUAGES.jp).toBe('japanese');
  });
});
