import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { NytProvider } from './nyt-provider.js';
import { ImportListError } from './errors.js';

const NYT_BASE = 'https://api.nytimes.com';

describe('NytProvider', () => {
  const server = useMswServer();

  describe('fetchItems', () => {
    it('fetches audio-fiction list and maps to ImportListItem[]', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get('api-key')).toBe('test-key');
          return HttpResponse.json({
            results: {
              books: [
                { title: 'The Way of Kings', author: 'Brandon Sanderson', primary_isbn13: '9780765365279' },
                { title: 'Project Hail Mary', author: 'Andy Weir' },
              ],
            },
          });
        }),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ title: 'The Way of Kings', author: 'Brandon Sanderson', isbn: '9780765365279' });
      expect(items[1]).toEqual({ title: 'Project Hail Mary', author: 'Andy Weir', isbn: undefined });
    });

    it('fetches audio-nonfiction list', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-nonfiction.json`, () => HttpResponse.json({
          results: { books: [{ title: 'Greenlights', author: 'Matthew McConaughey' }] },
        })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-nonfiction' });
      const items = await provider.fetchItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Greenlights');
    });

    it('returns empty array when no items', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () => HttpResponse.json({
          results: { books: [] },
        })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();
      expect(items).toEqual([]);
    });

    it('throws on rate limit (429)', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          new HttpResponse(null, { status: 429, statusText: 'Too Many Requests' })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      await expect(provider.fetchItems()).rejects.toThrow('rate limit');
    });
  });

  describe('test', () => {
    it('returns success when API key is valid', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () => HttpResponse.json({
          results: { books: [] },
        })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const result = await provider.test();
      expect(result).toEqual({ success: true });
    });

    it('returns failure for invalid API key', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          new HttpResponse(null, { status: 401, statusText: 'Unauthorized' })),
      );

      const provider = new NytProvider({ apiKey: 'bad-key', list: 'audio-fiction' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid API key');
    });

    it('returns stringified value when fetch throws a non-Error value', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network-string-error'));

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: network-string-error');

      vi.unstubAllGlobals();
    });
  });

  describe('schema validation', () => {
    it('throws ImportListError with ZodError cause when results.books is null', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({ results: { books: null } })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      const zod = await import('zod');
      expect((err as ImportListError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws ImportListError when book.title is a number', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({ results: { books: [{ title: 42 }] } })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
    });

    it('test() returns success: false when response is malformed', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json('html-interstitial')),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });

    it('passes through unknown extra fields and still maps successfully', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({
            results: {
              books: [{ title: 'X', author: 'Y', new_field: 'z' }],
              extra_metadata: 'unknown',
            },
            envelope_extra: 'unknown',
          })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();
      expect(items).toEqual([{ title: 'X', author: 'Y', isbn: undefined }]);
    });
  });
});
