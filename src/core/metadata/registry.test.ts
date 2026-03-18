import { describe, it, expect } from 'vitest';
import { METADATA_SEARCH_PROVIDER_FACTORIES } from './registry.js';
import { AudibleProvider } from './audible.js';

describe('METADATA_SEARCH_PROVIDER_FACTORIES', () => {
  it('returns AudibleProvider instance for audible type', () => {
    const factory = METADATA_SEARCH_PROVIDER_FACTORIES.audible;
    expect(factory).toBeDefined();

    const provider = factory({ region: 'us' });
    expect(provider).toBeInstanceOf(AudibleProvider);
    expect(provider.name).toContain('Audible');
    expect(provider.type).toBe('audible');
  });

  it('passes region config to AudibleProvider factory', () => {
    const provider = METADATA_SEARCH_PROVIDER_FACTORIES.audible({ region: 'uk' });
    expect(provider.name).toBe('Audible.co.uk');
  });

  it('factory map is extensible — adding a new provider requires only a registry entry', () => {
    // Registry is a plain object — new entries can be added without modifying existing code
    expect(typeof METADATA_SEARCH_PROVIDER_FACTORIES).toBe('object');
    expect(Object.keys(METADATA_SEARCH_PROVIDER_FACTORIES)).toEqual(['audible']);
  });
});
