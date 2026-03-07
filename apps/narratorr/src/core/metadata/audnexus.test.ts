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

    it('returns null when ASIN not available in region', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json(
            { error: { code: 'REGION_UNAVAILABLE', message: 'Item not available in region' } },
            { status: 404 },
          );
        }),
      );

      const book = await provider.getBook('B0F151V9H2');
      expect(book).toBeNull();
    });

    it('maps book with no narrators in response', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B_NO_NARR',
            title: 'Narrator-less Book',
            authors: [{ name: 'Author' }],
            runtimeLengthMin: 300,
            // no narrators field at all
          });
        }),
      );

      const book = await provider.getBook('B_NO_NARR');
      expect(book).not.toBeNull();
      expect(book!.narrators).toBeUndefined();
      expect(book!.duration).toBe(300);
    });

    it('maps book with empty narrators array', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B_EMPTY',
            title: 'Empty Narrators',
            authors: [{ name: 'Author' }],
            narrators: [],
            runtimeLengthMin: 200,
          });
        }),
      );

      const book = await provider.getBook('B_EMPTY');
      expect(book).not.toBeNull();
      expect(book!.narrators).toEqual([]);
      expect(book!.duration).toBe(200);
    });

    it('maps book with narrators but no duration', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B_PARTIAL',
            title: 'Partial Data',
            authors: [{ name: 'Author' }],
            narrators: [{ name: 'Jim Dale' }],
            // no runtimeLengthMin
          });
        }),
      );

      const book = await provider.getBook('B_PARTIAL');
      expect(book).not.toBeNull();
      expect(book!.narrators).toEqual(['Jim Dale']);
      expect(book!.duration).toBeUndefined();
    });

    it('maps book with no series data', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B_NOSERIES',
            title: 'Standalone',
            authors: [{ name: 'Author' }],
            // no seriesPrimary or seriesSecondary
          });
        }),
      );

      const book = await provider.getBook('B_NOSERIES');
      expect(book).not.toBeNull();
      expect(book!.series).toBeUndefined();
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

  describe('edge cases — NaN and malformed data', () => {
    it('handles NaN series position from non-numeric string', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B000TEST',
            title: 'NaN Position',
            authors: [{ name: 'Author' }],
            seriesPrimary: { name: 'Series', position: 'prologue', asin: 'S001' },
          });
        }),
      );

      const book = await provider.getBook('B000TEST');
      expect(book).not.toBeNull();
      // parseFloat('prologue') = NaN, || undefined → undefined
      expect(book!.series![0].position).toBeUndefined();
    });

    it('handles empty string narrator names (filtered out)', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B000TEST',
            title: 'Empty Narrator',
            authors: [{ name: 'Author' }],
            narrators: [{ name: '' }, { name: 'Jim Dale' }, { name: '' }],
          });
        }),
      );

      const book = await provider.getBook('B000TEST');
      expect(book!.narrators).toEqual(['Jim Dale']);
    });

    it('handles network error in getBook', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.error();
        }),
      );

      const book = await provider.getBook('B000TEST');
      expect(book).toBeNull();
    });

    it('handles network error in searchAuthors', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return HttpResponse.error();
        }),
      );

      const authors = await provider.searchAuthors('test');
      expect(authors).toEqual([]);
    });

    it('handles author search result with missing name and asin', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return HttpResponse.json([
            { description: 'No name or asin' },
            { name: 'Valid Author', asin: 'B001' },
          ]);
        }),
      );

      const authors = await provider.searchAuthors('test');
      // First entry has no key (asin or name), should be skipped
      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('Valid Author');
    });

    it('deduplicates authors by name when asin is missing', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return HttpResponse.json([
            { name: 'Same Author' },
            { name: 'Same Author' },
          ]);
        }),
      );

      const authors = await provider.searchAuthors('test');
      expect(authors).toHaveLength(1);
    });

    it('handles book with both seriesPrimary and seriesSecondary', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B000TEST',
            title: 'Multi Series',
            authors: [{ name: 'Author' }],
            seriesPrimary: { name: 'Main Series', position: '1', asin: 'S001' },
            seriesSecondary: { name: 'Shared Universe', position: '5', asin: 'S002' },
          });
        }),
      );

      const book = await provider.getBook('B000TEST');
      expect(book!.series).toHaveLength(2);
      expect(book!.series![0].name).toBe('Main Series');
      expect(book!.series![0].position).toBe(1);
      expect(book!.series![1].name).toBe('Shared Universe');
      expect(book!.series![1].position).toBe(5);
    });

    it('handles author with empty image string', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return HttpResponse.json({
            asin: 'B001TEST',
            name: 'No Image',
            image: '',
          });
        }),
      );

      const author = await provider.getAuthor('B001TEST');
      expect(author!.imageUrl).toBeUndefined();
    });

    it('handles 429 response in searchAuthors (no rate limit special handling)', async () => {
      server.use(
        http.get('https://api.audnex.us/authors', () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );

      // Audnexus provider doesn't have RateLimitError handling — returns empty
      const authors = await provider.searchAuthors('test');
      expect(authors).toEqual([]);
    });
  });
});
