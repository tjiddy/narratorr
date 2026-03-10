import { describe, it, expect, vi } from 'vitest';

// Mock the client module to control URL_BASE
vi.mock('./api/client.js', () => ({
  URL_BASE: '/narratorr',
}));

import { resolveUrl } from './url-utils';

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
