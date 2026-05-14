import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { NytProvider, titleCase } from './nyt-provider.js';
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
      expect(items[0]!.title).toBe('Greenlights');
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

    it('maps AbortSignal.timeout DOMException to "Connection failed: Request timed out"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: Request timed out');

      vi.unstubAllGlobals();
    });
  });

  describe('timeout helper', () => {
    it('fetchItems propagates "Request timed out" when fetch aborts via AbortSignal.timeout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      await expect(provider.fetchItems()).rejects.toThrow('Request timed out');

      vi.unstubAllGlobals();
    });
  });

  describe('titleCase helper', () => {
    it.each([
      ['GOLDEN SON', 'Golden Son'],
      ['THE WAY OF KINGS', 'The Way of Kings'],
      ['I AM PILGRIM', 'I Am Pilgrim'],
      ['YESTERYEAR: A GMA BOOK CLUB PICK', 'Yesteryear: A GMA Book Club Pick'],
      ['NOT TILL WE ARE LOST', 'Not Till We Are Lost'],
    ])('%s → %s', (input, expected) => {
      expect(titleCase(input)).toBe(expected);
    });

    it('returns empty string for empty input', () => {
      expect(titleCase('')).toBe('');
    });

    it('trims leading/trailing whitespace', () => {
      expect(titleCase('  THE BOOK  ')).toBe('The Book');
    });

    it('passes through mixed-case input unchanged (publisher casing wins)', () => {
      expect(titleCase('A Tale of Two Cities')).toBe('A Tale of Two Cities');
      expect(titleCase('iPhone Stories')).toBe('iPhone Stories');
    });

    it('handles a single word', () => {
      expect(titleCase('GREENLIGHTS')).toBe('Greenlights');
    });

    it('first word after subtitle colon is always capitalized', () => {
      expect(titleCase('THE TITLE: AN ADVENTURE')).toBe('The Title: An Adventure');
    });

    it('first-token short prepositions ARE capitalized', () => {
      expect(titleCase('OF MICE AND MEN')).toBe('Of Mice and Men');
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

    it('captures book_image as coverUrl and description from response', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({
            results: {
              books: [{
                title: 'GOLDEN SON', author: 'Pierce Brown',
                primary_isbn13: '9781101905760',
                book_image: 'https://nyt.com/cover.jpg',
                description: 'Sequel to Red Rising.',
              }],
            },
          })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();
      expect(items[0]).toEqual({
        title: 'Golden Son',
        author: 'Pierce Brown',
        isbn: '9781101905760',
        coverUrl: 'https://nyt.com/cover.jpg',
        description: 'Sequel to Red Rising.',
      });
    });

    it('schema still parses when book_image and description are absent (NYT omits on freshly-listed entries)', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({
            results: { books: [{ title: 'No Extras', author: 'Author', primary_isbn13: '9999999999999' }] },
          })),
      );
      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();
      expect(items[0]).toMatchObject({ title: 'No Extras', author: 'Author' });
      expect(items[0]!.coverUrl).toBeUndefined();
      expect(items[0]!.description).toBeUndefined();
    });

    it('title-cases ALL CAPS NYT titles at fetch time (proactive fix, not waiting for enrichment)', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({
            results: {
              books: [
                { title: 'GOLDEN SON', author: 'A' },
                { title: 'THE WAY OF KINGS', author: 'A' },
                { title: 'I AM PILGRIM', author: 'A' },
                { title: 'YESTERYEAR: A GMA BOOK CLUB PICK', author: 'A' },
                { title: 'NOT TILL WE ARE LOST', author: 'A' },
              ],
            },
          })),
      );
      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();
      expect(items.map((i) => i.title)).toEqual([
        'Golden Son',
        'The Way of Kings',
        'I Am Pilgrim',
        'Yesteryear: A GMA Book Club Pick',
        'Not Till We Are Lost',
      ]);
    });

    it('accepts null for nullish leaf fields (author, primary_isbn13, primary_isbn10)', async () => {
      server.use(
        http.get(`${NYT_BASE}/svc/books/v3/lists/current/audio-fiction.json`, () =>
          HttpResponse.json({
            results: {
              books: [
                { title: 'Standalone', author: null, primary_isbn13: null, primary_isbn10: null },
              ],
            },
          })),
      );

      const provider = new NytProvider({ apiKey: 'test-key', list: 'audio-fiction' });
      const items = await provider.fetchItems();
      expect(items).toEqual([{ title: 'Standalone', author: undefined, isbn: undefined }]);
    });
  });
});
