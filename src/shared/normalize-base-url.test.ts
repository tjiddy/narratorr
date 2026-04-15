import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl } from './normalize-base-url.js';

describe('normalizeBaseUrl', () => {
  it('strips single trailing slash from URL', () => {
    expect(normalizeBaseUrl('https://example.com/api/')).toBe('https://example.com/api');
  });

  it('strips multiple trailing slashes from URL', () => {
    expect(normalizeBaseUrl('https://example.com/api///')).toBe('https://example.com/api');
  });

  it('returns URL unchanged when no trailing slash', () => {
    expect(normalizeBaseUrl('https://example.com/api')).toBe('https://example.com/api');
  });

  it('handles empty string without throwing', () => {
    expect(normalizeBaseUrl('')).toBe('');
  });

  it('returns undefined for undefined input (nullable passthrough)', () => {
    expect(normalizeBaseUrl(undefined)).toBeUndefined();
  });
});
