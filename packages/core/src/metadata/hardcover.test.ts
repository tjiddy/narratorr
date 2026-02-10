import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { HardcoverProvider } from './hardcover.js';

const API_URL = 'https://api.hardcover.app/v1/graphql';

describe('HardcoverProvider', () => {
  const server = useMswServer();
  let provider: HardcoverProvider;

  beforeEach(() => {
    provider = new HardcoverProvider({ apiKey: 'test-api-key' });
  });

  describe('searchBooks', () => {
    it('returns mapped books from search results', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books).toHaveLength(2);
      expect(books[0].title).toBe('The Way of Kings');
      expect(books[0].subtitle).toBe('Book One of the Stormlight Archive');
      expect(books[0].authors).toEqual([{ name: 'Brandon Sanderson' }]);
      expect(books[0].genres).toEqual(['Fantasy', 'Epic Fantasy', 'High Fantasy']);
    });

    it('maps series info from search results', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].series).toEqual([
        { name: 'The Stormlight Archive', position: 1 },
      ]);
    });

    it('converts audio_seconds to duration in minutes', async () => {
      const books = await provider.searchBooks('Way of Kings');

      // 162840 seconds / 60 = 2714 minutes
      expect(books[0].duration).toBe(2714);
    });

    it('handles image as string or object', async () => {
      const books = await provider.searchBooks('Way of Kings');

      // First book has image as string
      expect(books[0].coverUrl).toBe('https://assets.hardcover.app/328491/cover.jpg');
      // Second book has image as { url }
      expect(books[1].coverUrl).toBe('https://assets.hardcover.app/328500/cover.jpg');
    });

    it('returns empty array on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const books = await provider.searchBooks('test');
      expect(books).toEqual([]);
    });

    it('returns empty array on GraphQL errors', async () => {
      server.use(
        http.post(API_URL, () =>
          HttpResponse.json({ errors: [{ message: 'Bad query' }] }),
        ),
      );

      const books = await provider.searchBooks('test');
      expect(books).toEqual([]);
    });
  });

  describe('searchAuthors', () => {
    it('returns mapped authors from search results', async () => {
      const authors = await provider.searchAuthors('Brandon');

      expect(authors).toHaveLength(2);
      expect(authors[0].name).toBe('Brandon Sanderson');
      expect(authors[1].name).toBe('Brandon Mull');
    });

    it('maps image URL from author search', async () => {
      const authors = await provider.searchAuthors('Brandon');

      expect(authors[0].imageUrl).toBe('https://assets.hardcover.app/authors/15200.jpg');
    });

    it('returns empty array on error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const authors = await provider.searchAuthors('test');
      expect(authors).toEqual([]);
    });
  });

  describe('searchSeries', () => {
    it('returns mapped series with empty books array', async () => {
      const series = await provider.searchSeries('Stormlight');

      expect(series).toHaveLength(1);
      expect(series[0].name).toBe('The Stormlight Archive');
      expect(series[0].books).toEqual([]);
    });

    it('returns empty array on error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const series = await provider.searchSeries('test');
      expect(series).toEqual([]);
    });
  });

  describe('search', () => {
    it('merges results from all three search types', async () => {
      const results = await provider.search('Brandon Sanderson');

      expect(results.books.length).toBeGreaterThan(0);
      expect(results.authors.length).toBeGreaterThan(0);
      expect(results.series.length).toBeGreaterThan(0);
    });

    it('handles partial failures gracefully', async () => {
      // Make book search fail but let author/series succeed
      let callCount = 0;
      server.use(
        http.post(API_URL, async ({ request }) => {
          const body = (await request.json()) as { variables?: Record<string, unknown> };
          const type = body.variables?.type as string;
          callCount++;
          if (type === 'Book') {
            return new HttpResponse(null, { status: 500 });
          }
          // Re-import fixtures for non-book types
          if (type === 'Author') {
            const fixture = await import('../__tests__/fixtures/hardcover-author-search.json');
            return HttpResponse.json(fixture.default ?? fixture);
          }
          if (type === 'Series') {
            const fixture = await import('../__tests__/fixtures/hardcover-series-search.json');
            return HttpResponse.json(fixture.default ?? fixture);
          }
          return HttpResponse.json({ data: null });
        }),
      );

      const results = await provider.search('test');

      expect(results.books).toEqual([]);
      expect(results.authors.length).toBeGreaterThan(0);
      expect(results.series.length).toBeGreaterThan(0);
    });
  });

  describe('getBook', () => {
    it('returns full mapped book metadata', async () => {
      const book = await provider.getBook('328491');

      expect(book).not.toBeNull();
      expect(book!.title).toBe('The Way of Kings');
      expect(book!.subtitle).toBe('Book One of the Stormlight Archive');
      expect(book!.description).toBe('Roshar is a world of stone and storms.');
    });

    it('maps authors and narrators from contributions', async () => {
      const book = await provider.getBook('328491');

      expect(book!.authors).toEqual([{ name: 'Brandon Sanderson' }]);
      expect(book!.narrators).toEqual(['Kate Reading', 'Michael Kramer']);
    });

    it('maps series from featured_book_series', async () => {
      const book = await provider.getBook('328491');

      expect(book!.series).toEqual([
        { name: 'The Stormlight Archive', position: 1 },
      ]);
    });

    it('maps cover URL from cached_image', async () => {
      const book = await provider.getBook('328491');

      expect(book!.coverUrl).toBe('https://assets.hardcover.app/328491/cover.jpg');
    });

    it('maps ASIN from default_audio_edition', async () => {
      const book = await provider.getBook('328491');

      expect(book!.asin).toBe('B003ZWFO7E');
    });

    it('maps ISBN from default_audio_edition', async () => {
      const book = await provider.getBook('328491');

      expect(book!.isbn).toBe('9780765365286');
    });

    it('converts audio_seconds to duration in minutes', async () => {
      const book = await provider.getBook('328491');

      expect(book!.duration).toBe(2714);
    });

    it('maps genres from cached_tags', async () => {
      const book = await provider.getBook('328491');

      expect(book!.genres).toEqual(['Fantasy', 'Epic Fantasy', 'High Fantasy']);
    });

    it('maps publisher from audio edition', async () => {
      const book = await provider.getBook('328491');

      expect(book!.publisher).toBe('Macmillan Audio');
    });

    it('returns null on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const book = await provider.getBook('328491');
      expect(book).toBeNull();
    });
  });

  describe('getAuthor', () => {
    it('returns mapped author with bio and image', async () => {
      const author = await provider.getAuthor('15200');

      expect(author).not.toBeNull();
      expect(author!.name).toBe('Brandon Sanderson');
      expect(author!.description).toBe(
        'Brandon Sanderson is an American author of epic fantasy and science fiction.',
      );
      expect(author!.imageUrl).toBe('https://assets.hardcover.app/authors/15200.jpg');
    });

    it('returns null on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const author = await provider.getAuthor('15200');
      expect(author).toBeNull();
    });
  });

  describe('getAuthorBooks', () => {
    it('returns books where contribution is Author', async () => {
      const books = await provider.getAuthorBooks('15200');

      // Fixture has 2 Author contributions and 1 Narrator
      expect(books).toHaveLength(2);
      expect(books[0].title).toBe('The Way of Kings');
      expect(books[1].title).toBe('Words of Radiance');
    });

    it('excludes narrated books', async () => {
      const books = await provider.getAuthorBooks('15200');

      const titles = books.map((b) => b.title);
      expect(titles).not.toContain('Some Narrated Book');
    });

    it('returns empty array on error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const books = await provider.getAuthorBooks('15200');
      expect(books).toEqual([]);
    });
  });

  describe('getSeries', () => {
    it('returns series with ordered books', async () => {
      const series = await provider.getSeries('4578');

      expect(series).not.toBeNull();
      expect(series!.name).toBe('The Stormlight Archive');
      expect(series!.description).toBe(
        'An epic fantasy series set on the world of Roshar.',
      );
      expect(series!.books).toHaveLength(2);
      expect(series!.books[0].title).toBe('The Way of Kings');
      expect(series!.books[1].title).toBe('Words of Radiance');
    });

    it('returns null on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const series = await provider.getSeries('4578');
      expect(series).toBeNull();
    });
  });

  describe('test', () => {
    it('returns success when API is reachable', async () => {
      const result = await provider.test();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected to Hardcover API');
    });

    it('returns failure on 401', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 401 })),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.post(API_URL, () => HttpResponse.error()),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
    });
  });

  describe('authentication', () => {
    it('sends bare token (not Bearer) in authorization header', async () => {
      let capturedAuth = '';
      server.use(
        http.post(API_URL, ({ request }) => {
          capturedAuth = request.headers.get('authorization') ?? '';
          return HttpResponse.json({
            data: { search: { results: [] } },
          });
        }),
      );

      await provider.searchBooks('test');
      expect(capturedAuth).toBe('test-api-key');
      expect(capturedAuth).not.toMatch(/^Bearer /);
    });
  });
});
