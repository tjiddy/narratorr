import { describe, it, expect, vi } from 'vitest';

// Mock the client module to control URL_BASE
vi.mock('./api/client.js', () => ({
  URL_BASE: '/narratorr',
}));

import { resolveUrl, resolveCoverUrl } from './url-utils';

describe('resolveUrl', () => {
  it('prepends URL_BASE to app-relative path starting with /', () => {
    expect(resolveUrl('/api/books/1/cover')).toBe('/narratorr/api/books/1/cover');
  });

  it('does not prefix absolute http:// URL', () => {
    expect(resolveUrl('http://example.com/cover.jpg')).toBe('http://example.com/cover.jpg');
  });

  it('does not prefix absolute https:// URL', () => {
    expect(resolveUrl('https://media-amazon.com/images/cover.jpg')).toBe('https://media-amazon.com/images/cover.jpg');
  });

  it('returns undefined for null/undefined input', () => {
    expect(resolveUrl(null)).toBeUndefined();
    expect(resolveUrl(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(resolveUrl('')).toBeUndefined();
  });
});

describe('resolveCoverUrl', () => {
  describe('local cover URLs with cache-busting', () => {
    it('appends ?v=<epoch> to local cover URL with valid updatedAt', () => {
      const result = resolveCoverUrl('/api/books/1/cover', '2024-04-08T12:00:00Z');
      expect(result).toBe('/narratorr/api/books/1/cover?v=1712577600');
    });

    it('prepends URL_BASE and appends ?v=<epoch> for local cover URL', () => {
      const result = resolveCoverUrl('/api/books/42/cover', '2024-01-01T00:00:00Z');
      expect(result).toBe('/narratorr/api/books/42/cover?v=1704067200');
    });

    it('different updatedAt values produce different ?v= params', () => {
      const result1 = resolveCoverUrl('/api/books/1/cover', '2024-01-01T00:00:00Z');
      const result2 = resolveCoverUrl('/api/books/1/cover', '2024-06-15T12:00:00Z');
      expect(result1).not.toBe(result2);
    });
  });

  describe('external URLs pass through unchanged', () => {
    it('returns https:// URL unchanged even with updatedAt', () => {
      expect(resolveCoverUrl('https://media-amazon.com/cover.jpg', '2024-01-01T00:00:00Z'))
        .toBe('https://media-amazon.com/cover.jpg');
    });

    it('returns http:// URL unchanged even with updatedAt', () => {
      expect(resolveCoverUrl('http://example.com/cover.jpg', '2024-01-01T00:00:00Z'))
        .toBe('http://example.com/cover.jpg');
    });
  });

  describe('null/undefined/missing boundary cases', () => {
    it('returns undefined for null URL', () => {
      expect(resolveCoverUrl(null, '2024-01-01T00:00:00Z')).toBeUndefined();
    });

    it('returns undefined for undefined URL', () => {
      expect(resolveCoverUrl(undefined, '2024-01-01T00:00:00Z')).toBeUndefined();
    });

    it('returns undefined for empty string URL', () => {
      expect(resolveCoverUrl('', '2024-01-01T00:00:00Z')).toBeUndefined();
    });

    it('returns resolved URL without ?v= when updatedAt is null', () => {
      expect(resolveCoverUrl('/api/books/1/cover', null)).toBe('/narratorr/api/books/1/cover');
    });

    it('returns resolved URL without ?v= when updatedAt is undefined', () => {
      expect(resolveCoverUrl('/api/books/1/cover', undefined)).toBe('/narratorr/api/books/1/cover');
    });
  });
});
