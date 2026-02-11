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
      expect(books[0].subtitle).toBe('The Stormlight Archive Book One');
      expect(books[0].authors).toEqual([{ name: 'Brandon Sanderson' }]);
      expect(books[0].genres).toEqual(['Fantasy', 'Epic Fantasy', 'High Fantasy']);
    });

    it('maps series info from search results', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].series).toEqual([
        { name: 'The Stormlight Archive', position: 1 },
      ]);
    });

    it('maps cover URL from image object', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].coverUrl).toBe('https://assets.hardcover.app/386446/cover.jpg');
      expect(books[1].coverUrl).toBe('https://assets.hardcover.app/405234/cover.jpg');
    });

    it('maps text_match as relevance score', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].relevance).toBe(578);
      expect(books[1].relevance).toBe(456);
    });

    it('sorts books by relevance (highest first)', async () => {
      const books = await provider.searchBooks('Way of Kings');

      // First book (text_match=578) should rank above second (text_match=456)
      expect(books[0].title).toBe('The Way of Kings');
      expect(books[1].title).toBe('Words of Radiance');
      expect((books[0].relevance ?? 0)).toBeGreaterThan((books[1].relevance ?? 0));
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

      expect(authors[0].imageUrl).toBe('https://assets.hardcover.app/author/204214/img.jpg');
    });

    it('maps text_match as relevance score', async () => {
      const authors = await provider.searchAuthors('Brandon');

      expect(authors[0].relevance).toBe(890);
      expect(authors[1].relevance).toBe(650);
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
      server.use(
        http.post(API_URL, async ({ request }) => {
          const body = (await request.json()) as { variables?: Record<string, unknown> };
          const type = body.variables?.type as string;
          if (type === 'Book') {
            return new HttpResponse(null, { status: 500 });
          }
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
      const book = await provider.getBook('386446');

      expect(book).not.toBeNull();
      expect(book!.title).toBe('The Way of Kings');
      expect(book!.subtitle).toBe('The Stormlight Archive Book One');
      expect(book!.description).toBe('Roshar is a world of stone and storms.');
    });

    it('maps authors from contributions', async () => {
      const book = await provider.getBook('386446');

      expect(book!.authors).toEqual([{ name: 'Brandon Sanderson' }]);
    });

    it('omits narrators when contribution type is null', async () => {
      const book = await provider.getBook('386446');

      // Hardcover returns contribution as null, so narrators can't be extracted
      expect(book!.narrators).toBeUndefined();
    });

    it('maps series from featured_book_series', async () => {
      const book = await provider.getBook('386446');

      expect(book!.series).toEqual([
        { name: 'The Stormlight Archive', position: 1 },
      ]);
    });

    it('maps cover URL from cached_image', async () => {
      const book = await provider.getBook('386446');

      expect(book!.coverUrl).toBe('https://assets.hardcover.app/386446/cover.jpg');
    });

    it('maps ASIN from editions when default_audio_edition has none', async () => {
      const book = await provider.getBook('386446');

      // default_audio_edition.asin is null, editions[0].asin is "B003ZWFO7E"
      expect(book!.asin).toBe('B003ZWFO7E');
    });

    it('maps ISBN from default_audio_edition', async () => {
      const book = await provider.getBook('386446');

      expect(book!.isbn).toBe('9781427209757');
    });

    it('picks audio_seconds from editions over default_audio_edition', async () => {
      const book = await provider.getBook('386446');

      // editions[0].audio_seconds = 163800 → 163800 / 60 = 2730
      expect(book!.duration).toBe(2730);
    });

    it('maps genres from cached_tags tag objects', async () => {
      const book = await provider.getBook('386446');

      expect(book!.genres).toEqual(['Fantasy', 'Epic Fantasy', 'High Fantasy']);
    });

    it('maps publisher from audio edition', async () => {
      const book = await provider.getBook('386446');

      expect(book!.publisher).toBe('Macmillan Audio');
    });

    it('returns null on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const book = await provider.getBook('386446');
      expect(book).toBeNull();
    });
  });

  describe('getAuthor', () => {
    it('returns mapped author with bio and image', async () => {
      const author = await provider.getAuthor('204214');

      expect(author).not.toBeNull();
      expect(author!.name).toBe('Brandon Sanderson');
      expect(author!.description).toBe(
        'Brandon Sanderson is an American author of epic fantasy and science fiction.',
      );
      expect(author!.imageUrl).toBe('https://assets.hardcover.app/author/204214/img.jpg');
    });

    it('returns null on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const author = await provider.getAuthor('204214');
      expect(author).toBeNull();
    });
  });

  describe('getAuthorBooks', () => {
    it('returns all books from author contributions', async () => {
      const books = await provider.getAuthorBooks('204214');

      // Fixture has 2 contributions (both with contribution: null)
      expect(books).toHaveLength(2);
      expect(books[0].title).toBe('The Way of Kings');
      expect(books[1].title).toBe('Words of Radiance');
    });

    it('returns empty array on error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const books = await provider.getAuthorBooks('204214');
      expect(books).toEqual([]);
    });
  });

  describe('getSeries', () => {
    it('returns series with ordered books', async () => {
      const series = await provider.getSeries('997');

      expect(series).not.toBeNull();
      expect(series!.name).toBe('The Stormlight Archive');
      expect(series!.books).toHaveLength(2);
      expect(series!.books[0].title).toBe('The Way of Kings');
      expect(series!.books[1].title).toBe('Words of Radiance');
    });

    it('handles null description', async () => {
      const series = await provider.getSeries('997');

      expect(series!.description).toBeUndefined();
    });

    it('returns null on API error', async () => {
      server.use(
        http.post(API_URL, () => new HttpResponse(null, { status: 500 })),
      );

      const series = await provider.getSeries('997');
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
    it('sends Bearer token in authorization header', async () => {
      let capturedAuth = '';
      server.use(
        http.post(API_URL, ({ request }) => {
          capturedAuth = request.headers.get('authorization') ?? '';
          return HttpResponse.json({
            data: { search: { results: { hits: [], found: 0 } } },
          });
        }),
      );

      await provider.searchBooks('test');
      expect(capturedAuth).toBe('Bearer test-api-key');
    });
  });
});
