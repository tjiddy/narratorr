import { describe, it, expect } from 'vitest';
import { READARR_ECHO_ONLY_FIELDS, stripReadarrEchoOnlyFields } from './readarr-echo-fields.js';

describe('stripReadarrEchoOnlyFields (#1198)', () => {
  it('removes every Readarr echo-only key', () => {
    const result = stripReadarrEchoOnlyFields({
      apiUrl: 'http://prowlarr:9696/1/',
      apiKey: 'abc123',
      categories: [3030],
      minimumSeeders: 0,
      'seedCriteria.seedRatio': null,
      'seedCriteria.seedTime': null,
    });

    expect(result).toEqual({ apiUrl: 'http://prowlarr:9696/1/', apiKey: 'abc123' });
  });

  it('preserves adapter-accepted and local-only keys', () => {
    const result = stripReadarrEchoOnlyFields({
      apiUrl: 'http://prowlarr:9696/1/',
      apiKey: 'abc123',
      flareSolverrUrl: 'http://flaresolverr:8191',
      useProxy: true,
      categories: [3030],
    });

    expect(result).toEqual({
      apiUrl: 'http://prowlarr:9696/1/',
      apiKey: 'abc123',
      flareSolverrUrl: 'http://flaresolverr:8191',
      useProxy: true,
    });
  });

  it('returns a new object (does not mutate the input)', () => {
    const input = { apiUrl: 'http://x/', categories: [3030] };
    const result = stripReadarrEchoOnlyFields(input);
    expect(result).not.toBe(input);
    expect(input).toHaveProperty('categories');
  });

  it('is a no-op for already-clean settings', () => {
    const clean = { apiUrl: 'http://x/', apiKey: 'k' };
    expect(stripReadarrEchoOnlyFields(clean)).toEqual(clean);
  });

  it('exposes the canonical echo-only field set', () => {
    expect([...READARR_ECHO_ONLY_FIELDS].sort()).toEqual(
      ['categories', 'minimumSeeders', 'seedCriteria.seedRatio', 'seedCriteria.seedTime'].sort(),
    );
  });
});
