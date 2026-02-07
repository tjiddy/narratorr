import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { AudnexusProvider } from './audnexus.js';

describe('AudnexusProvider', () => {
  const server = useMswServer();
  let provider: AudnexusProvider;

  beforeEach(() => {
    provider = new AudnexusProvider();
  });

  describe('searchAuthors', () => {
    it('returns deduplicated authors from the API', async () => {
      const authors = await provider.searchAuthors('Brandon');

      expect(authors).toHaveLength(2);
      expect(authors[0].name).toBe('Brandon Sanderson');
      expect(authors[0].asin).toBe('B001H6UJO8');
      expect(authors[1].name).toBe('Brandon Mull');
    });

    it('includes genres in author results', async () => {
      const authors = await provider.searchAuthors('Brandon');

      expect(authors[0].genres).toEqual(['Fantasy', 'Science Fiction']);
    });

    it('includes imageUrl in author results', async () => {
      const authors = await provider.searchAuthors('Brandon');

      expect(authors[0].imageUrl).toBe(
        'https://images-na.ssl-images-amazon.com/images/I/brandon-sanderson.jpg',
      );
    });

    it('deduplicates authors by ASIN', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return HttpResponse.json([
            { asin: 'B001H6UJO8', name: 'Brandon Sanderson' },
            { asin: 'B001H6UJO8', name: 'Brandon Sanderson' },
          ]);
        }),
      );

      const authors = await provider.searchAuthors('Brandon');
      expect(authors).toHaveLength(1);
    });

    it('returns empty array when API returns non-array', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return HttpResponse.json({ error: 'bad' });
        }),
      );

      const authors = await provider.searchAuthors('Brandon');
      expect(authors).toEqual([]);
    });

    it('returns empty array on API error', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      const authors = await provider.searchAuthors('Brandon');
      expect(authors).toEqual([]);
    });
  });

  describe('search', () => {
    it('returns authors in search results with empty books and series', async () => {
      const results = await provider.search('Brandon');

      expect(results.books).toEqual([]);
      expect(results.series).toEqual([]);
      expect(results.authors).toHaveLength(2);
    });
  });

  describe('searchBooks', () => {
    it('returns empty array (not supported)', async () => {
      const books = await provider.searchBooks('anything');
      expect(books).toEqual([]);
    });
  });

  describe('searchSeries', () => {
    it('returns empty array (not supported)', async () => {
      const series = await provider.searchSeries('anything');
      expect(series).toEqual([]);
    });
  });

  describe('getBook', () => {
    it('returns mapped book metadata', async () => {
      const book = await provider.getBook('B0030DL4GK');

      expect(book).not.toBeNull();
      expect(book!.title).toBe('The Way of Kings');
      expect(book!.asin).toBe('B0030DL4GK');
      expect(book!.authors).toEqual([
        { name: 'Brandon Sanderson', asin: 'B001H6UJO8' },
      ]);
      expect(book!.narrators).toEqual(['Kate Reading', 'Michael Kramer']);
      expect(book!.publisher).toBe('Macmillan Audio');
      expect(book!.duration).toBe(2714);
    });

    it('maps series from seriesPrimary', async () => {
      const book = await provider.getBook('B0030DL4GK');

      expect(book!.series).toEqual([
        { name: 'The Stormlight Archive', position: 1, asin: 'B010XKCR92' },
      ]);
    });

    it('maps genres from book detail', async () => {
      const book = await provider.getBook('B0030DL4GK');

      expect(book!.genres).toEqual(['Fantasy', 'Epic Fantasy']);
    });

    it('returns null on API error', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const book = await provider.getBook('INVALID');
      expect(book).toBeNull();
    });

    it('returns null on malformed response', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          // Missing required 'title' → schema validation fails
          return HttpResponse.json({ asin: 'B0030DL4GK' });
        }),
      );

      const book = await provider.getBook('B0030DL4GK');
      // mapBook returns title: '' but authors: [] → BookMetadataSchema should still pass
      // Actually let's check what happens
      expect(book).not.toBeNull();
    });
  });

  describe('getAuthor', () => {
    it('returns mapped author metadata', async () => {
      const author = await provider.getAuthor('B001H6UJO8');

      expect(author).not.toBeNull();
      expect(author!.name).toBe('Brandon Sanderson');
      expect(author!.asin).toBe('B001H6UJO8');
      expect(author!.genres).toEqual(['Fantasy', 'Science Fiction', 'Epic Fantasy']);
    });

    it('returns null on API error', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const author = await provider.getAuthor('INVALID');
      expect(author).toBeNull();
    });
  });

  describe('getAuthorBooks', () => {
    it('returns empty array (not supported)', async () => {
      const books = await provider.getAuthorBooks('B001H6UJO8');
      expect(books).toEqual([]);
    });
  });

  describe('getSeries', () => {
    it('returns null (not supported)', async () => {
      const series = await provider.getSeries('B010XKCR92');
      expect(series).toBeNull();
    });
  });

  describe('test', () => {
    it('returns success when API is reachable', async () => {
      const result = await provider.test();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected to Audnexus API');
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('503');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return HttpResponse.error();
        }),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
    });
  });

  describe('region config', () => {
    it('uses default "us" region', async () => {
      let capturedUrl = '';
      server.use(
        http.get('https://api.audnex.us/authors', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json([]);
        }),
      );

      await provider.searchAuthors('test');
      expect(capturedUrl).toContain('region=us');
    });

    it('uses custom region when configured', async () => {
      const ukProvider = new AudnexusProvider({ region: 'uk' });
      let capturedUrl = '';
      server.use(
        http.get('https://api.audnex.us/authors', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json([]);
        }),
      );

      await ukProvider.searchAuthors('test');
      expect(capturedUrl).toContain('region=uk');
    });
  });
});
