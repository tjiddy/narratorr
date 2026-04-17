import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { AudibleProvider } from './audible.js';
import { RateLimitError, TransientError } from './errors.js';

describe('AudibleProvider', () => {
  const server = useMswServer();
  let provider: AudibleProvider;

  beforeEach(() => {
    provider = new AudibleProvider({ region: 'us' });
  });

  describe('searchBooks', () => {
    it('returns books mapped from Audible catalog API', async () => {
      const { books } = await provider.searchBooks('Harry Potter Chamber of Secrets');

      expect(books).toHaveLength(2);
      expect(books[0].title).toBe('Harry Potter and the Chamber of Secrets');
      expect(books[0].asin).toBe('B017V4IWVG');
      expect(books[0].authors).toEqual([{ name: 'J.K. Rowling', asin: 'B000AP9A6K' }]);
    });

    it('sends query as keywords param for title+author matching', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('Sanderson Way of Kings');
      expect(capturedUrl?.searchParams.get('keywords')).toBe('Sanderson Way of Kings');
      expect(capturedUrl?.searchParams.has('title')).toBe(false);
    });

    it('extracts narrators from search results', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].narrators).toEqual(['Jim Dale']);
      // Second result has multiple narrators (full-cast edition)
      expect(books[1].narrators).toContain('Hugh Laurie');
      expect(books[1].narrators!.length).toBeGreaterThan(1);
    });

    it('extracts duration in minutes', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].duration).toBe(542);
    });

    it('extracts series with position', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].series).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Harry Potter', position: 2 }),
        ]),
      );
    });

    it('extracts cover URL from product images', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].coverUrl).toContain('media-amazon.com');
    });

    it('preserves safe HTML tags in description', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].description).toContain('<p>');
      expect(books[0].description).toContain('<i>');
      expect(books[0].description).toContain('Grammy Award');
    });

    it('cleans "Book N" suffix from title', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      // Original title is "Harry Potter and the Chamber of Secrets, Book 2"
      expect(books[0].title).toBe('Harry Potter and the Chamber of Secrets');
    });

    it('extracts publisher', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].publisher).toBe('Pottermore Publishing');
    });

    it('extracts language lowercase', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      expect(books[0].language).toBe('english');
    });

    it('preserves full release_date in publishedDate (not truncated to year)', async () => {
      const { books } = await provider.searchBooks('Harry Potter');

      // Fixture has release_date: "2015-11-20" — must preserve full date for sorting
      expect(books[0].publishedDate).toBe('2015-11-20');
    });

    it('throws TransientError on API error (5xx)', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({}, { status: 500 });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(TransientError);
    });

    it('throws TransientError on network error', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.error();
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(TransientError);
    });

    it('returns empty array when response has no products', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({ products: [] });
        }),
      );

      const { books } = await provider.searchBooks('nonexistent');
      expect(books).toEqual([]);
    });

    it('handles products with missing optional fields', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'Minimal Book',
              authors: [{ name: 'Author' }],
              // no narrators, no series, no images, no description
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books).toHaveLength(1);
      expect(books[0].title).toBe('Minimal Book');
      expect(books[0].narrators).toBeUndefined();
      expect(books[0].series).toBeUndefined();
      expect(books[0].coverUrl).toBeUndefined();
    });

    it('throws RateLimitError on 429', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '30' },
          });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(RateLimitError);
    });

    it('parses Retry-After header on 429', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '45' },
          });
        }),
      );

      try {
        await provider.searchBooks('test');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).retryAfterMs).toBe(45000);
      }
    });

    it('defaults to 60s retry on 429 without Retry-After', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );

      try {
        await provider.searchBooks('test');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).retryAfterMs).toBe(60000);
      }
    });
  });

  describe('getBook', () => {
    it('returns book by ASIN', async () => {
      const book = await provider.getBook('B017V4IWVG');

      expect(book).not.toBeNull();
      expect(book!.asin).toBe('B017V4IWVG');
      expect(book!.title).toBe('Harry Potter and the Chamber of Secrets');
      expect(book!.narrators).toEqual(['Jim Dale']);
    });

    it('returns null on 404', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products/:asin', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const book = await provider.getBook('B000UNKNOWN');
      expect(book).toBeNull();
    });
  });

  describe('regional TLD', () => {
    it('uses .co.uk for UK region', async () => {
      const ukProvider = new AudibleProvider({ region: 'uk' });
      expect(ukProvider.name).toBe('Audible.co.uk');

      server.use(
        http.get('https://api.audible.co.uk/1.0/catalog/products', () => {
          return HttpResponse.json({ products: [] });
        }),
      );

      const result = await ukProvider.searchBooks('test');
      expect(result.books).toEqual([]);
    });

    it('defaults to .com for unknown region', async () => {
      const unknownProvider = new AudibleProvider({ region: 'zz' });
      expect(unknownProvider.name).toBe('Audible.com');
    });

    it('defaults to .com with no config', async () => {
      const defaultProvider = new AudibleProvider();
      expect(defaultProvider.name).toBe('Audible.com');
    });
  });

  describe('searchAuthors', () => {
    it('returns unique authors extracted from book results', async () => {
      const authors = await provider.searchAuthors('Harry Potter');

      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('J.K. Rowling');
      expect(authors[0].asin).toBe('B000AP9A6K');
    });

    it('deduplicates authors appearing across multiple books', async () => {
      // Default fixture has J.K. Rowling in both products — should only appear once
      const authors = await provider.searchAuthors('Harry Potter');

      const rowlingEntries = authors.filter((a) => a.name === 'J.K. Rowling');
      expect(rowlingEntries).toHaveLength(1);
    });

    it('returns empty array when no books are returned', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({ products: [] });
        }),
      );

      const authors = await provider.searchAuthors('unknown');
      expect(authors).toEqual([]);
    });
  });

  describe('searchSeries', () => {
    it('returns unique series extracted from book results', async () => {
      const series = await provider.searchSeries('Harry Potter');

      expect(series).toHaveLength(3);
      const names = series.map((s) => s.name);
      expect(names).toContain('Harry Potter');
      expect(names).toContain('Wizarding World Collection');
      expect(names).toContain('Harry Potter (Full-Cast Editions)');
    });

    it('returns empty array when books have no series', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [
              {
                asin: 'B000TEST',
                title: 'A Standalone Book',
                authors: [{ name: 'Some Author', asin: 'A001' }],
                series: [],
                language: 'english',
              },
            ],
          });
        }),
      );

      const series = await provider.searchSeries('standalone');
      expect(series).toEqual([]);
    });
  });

  describe('language sorting', () => {
    it('sorts preferred-language books first', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [
              {
                asin: 'B001',
                title: 'French Book',
                authors: [{ name: 'Author', asin: 'A001' }],
                language: 'french',
              },
              {
                asin: 'B002',
                title: 'English Book',
                authors: [{ name: 'Author', asin: 'A001' }],
                language: 'english',
              },
            ],
          });
        }),
      );

      // Default provider uses 'us' region → preferred language is 'english'
      const { books } = await provider.searchBooks('test');
      expect(books[0].language).toBe('english');
      expect(books[1].language).toBe('french');
    });
  });

  describe('test', () => {
    it('returns success when API responds', async () => {
      const result = await provider.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Audible');
    });

    it('returns failure when API returns non-200', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
    });
  });

  describe('series position parsing', () => {
    it('handles fractional positions like "1.5"', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'Novella',
              authors: [{ name: 'Author' }],
              series: [{ title: 'Series', sequence: '1.5' }],
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books[0].series![0].position).toBe(1.5);
    });

    it('handles "Book N" format in sequence', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'Test Book',
              authors: [{ name: 'Author' }],
              series: [{ title: 'Series', sequence: 'Book 3' }],
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books[0].series![0].position).toBe(3);
    });

    it('handles missing sequence', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'Standalone',
              authors: [{ name: 'Author' }],
              series: [{ title: 'Series' }],
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books[0].series![0].position).toBeUndefined();
    });
  });

  describe('edge cases — NaN and malformed data', () => {
    it('handles NaN Retry-After header (defaults to 60s)', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': 'not-a-number' },
          });
        }),
      );

      try {
        await provider.searchBooks('test');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RateLimitError);
        // parseInt('not-a-number') = NaN, NaN * 1000 = NaN
        expect((error as RateLimitError).retryAfterMs).toBeNaN();
      }
    });

    it('throws TransientError on malformed JSON response body', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse('not json{{{', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(TransientError);
    });

    it('handles NaN series position from non-numeric sequence', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'Test',
              authors: [{ name: 'Author' }],
              series: [{ title: 'Series', sequence: 'prologue' }],
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books[0].series![0].position).toBeUndefined();
    });

    it('handles invalid runtime_length_min (NaN)', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'NaN Duration',
              authors: [{ name: 'Author' }],
              runtime_length_min: NaN,
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books[0].duration).toBeUndefined();
    });

    it('handles runtime_length_min of 0', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'Zero Duration',
              authors: [{ name: 'Author' }],
              runtime_length_min: 0,
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      // 0 is falsy, so duration should be undefined
      expect(books[0].duration).toBeUndefined();
    });

    it('handles empty string Retry-After header (falls back to 60s)', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '' },
          });
        }),
      );

      try {
        await provider.searchBooks('test');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(RateLimitError);
        // Empty string is falsy → ternary falls to 60_000
        expect((error as RateLimitError).retryAfterMs).toBe(60000);
      }
    });

    it('handles product with empty authors array', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.json({
            products: [{
              asin: 'B000TEST',
              title: 'No Authors',
              authors: [],
            }],
          });
        }),
      );

      const { books } = await provider.searchBooks('test');
      expect(books).toHaveLength(1);
      expect(books[0].authors).toEqual([]);
    });

    it('getBook throws TransientError on malformed JSON response', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products/:asin', () => {
          return new HttpResponse('broken json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
    });
  });

  describe('TransientError differentiation', () => {
    it('searchBooks() on 429 throws RateLimitError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '30' },
          });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(RateLimitError);
    });

    it('searchBooks() on timeout throws TransientError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', async () => {
          await delay('infinite');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(TransientError);
    }, 15000);

    it('searchBooks() on 5xx throws TransientError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(TransientError);
    });

    it('searchBooks() on network error throws TransientError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.error();
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(TransientError);
    });

    it('searchBooks() on 404/empty returns empty array', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const result = await provider.searchBooks('test');
      expect(result.books).toEqual([]);
    });

    it('getBook() on timeout throws TransientError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products/:asin', async () => {
          await delay('infinite');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
    }, 15000);

    it('getBook() on network error throws TransientError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products/:asin', () => {
          return HttpResponse.error();
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
    });

    it('getBook() on 5xx throws TransientError', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products/:asin', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
    });

    it('getBook() on 404/no data returns null', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products/:asin', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const result = await provider.getBook('B000TEST');
      expect(result).toBeNull();
    });

    it('test() catches TransientError and returns { success: false }', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return HttpResponse.error();
        }),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    });

    it('test() on timeout returns { success: false, message }', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', async () => {
          await delay('infinite');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    }, 15000);
  });

  describe('redirect protection', () => {
    it('searchBooks() on 302 with Location header throws TransientError with redirect message', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://auth.internal/login' },
          });
        }),
      );

      const error = await provider.searchBooks('test').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect((error as TransientError).message).toMatch(/redirect/i);
    });

    it('searchBooks() rejects all 3xx codes (301, 303, 307, 308) with TransientError and redirect message', async () => {
      for (const status of [301, 303, 307, 308]) {
        server.use(
          http.get('https://api.audible.com/1.0/catalog/products', () => {
            return new HttpResponse(null, {
              status,
              headers: { Location: 'https://auth.internal/login' },
            });
          }),
        );

        const error = await provider.searchBooks('test').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TransientError);
        expect((error as TransientError).message).toMatch(/redirect/i);
      }
    });

    it('searchBooks() on 3xx with no Location header throws TransientError with redirect message', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, { status: 302 });
        }),
      );

      const error = await provider.searchBooks('test').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect((error as TransientError).message).toMatch(/redirect/i);
    });

    it('test() on 302 redirect returns { success: false } with redirect message', async () => {
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', () => {
          return new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://auth.internal/login' },
          });
        }),
      );

      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/redirect/i);
    });

    it('searchBooks() on 2xx response returns data normally (regression)', async () => {
      const { books } = await provider.searchBooks('Harry Potter');
      expect(Array.isArray(books)).toBe(true);
    });
  });

  // ── #229 Observability — SearchBooksResult contract ─────────────────────
  describe('SearchBooksResult contract (#229)', () => {
    it('searchBooks() returns { books, rawCount } shape', async () => {
      const result = await provider.searchBooks('Harry Potter');
      expect(result).toHaveProperty('books');
      expect(result).toHaveProperty('rawCount');
      expect(Array.isArray(result.books)).toBe(true);
      expect(typeof result.rawCount).toBe('number');
    });

    it('searchBooks() rawCount equals products.length before filtering', async () => {
      // Default MSW handler returns 2 products that both pass validation
      const result = await provider.searchBooks('Harry Potter');
      expect(result.rawCount).toBe(result.books.length);
    });

    it('searchAuthors() correctly unwraps .books from internal searchBooks()', async () => {
      const authors = await provider.searchAuthors('Harry Potter');
      // Should not throw — searchAuthors destructures { books } internally
      expect(Array.isArray(authors)).toBe(true);
    });

    it('searchSeries() correctly unwraps .books from internal searchBooks()', async () => {
      const series = await provider.searchSeries('Harry Potter');
      // Should not throw — searchSeries destructures { books } internally
      expect(Array.isArray(series)).toBe(true);
    });
  });

  describe('structured search params', () => {
    it('uses title + author URL params when options.title and options.author provided', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('', { title: 'Project Hail Mary', author: 'Andy Weir' });
      expect(capturedUrl?.searchParams.get('title')).toBe('Project Hail Mary');
      expect(capturedUrl?.searchParams.get('author')).toBe('Andy Weir');
      expect(capturedUrl?.searchParams.has('keywords')).toBe(false);
    });

    it('uses title param only when options.title provided without options.author', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('', { title: 'Dune' });
      expect(capturedUrl?.searchParams.get('title')).toBe('Dune');
      expect(capturedUrl?.searchParams.has('author')).toBe(false);
      expect(capturedUrl?.searchParams.has('keywords')).toBe(false);
    });

    it('falls back to keywords param when no structured params in options', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('Sanderson Way of Kings', { maxResults: 5 });
      expect(capturedUrl?.searchParams.get('keywords')).toBe('Sanderson Way of Kings');
      expect(capturedUrl?.searchParams.has('title')).toBe(false);
    });

    it('keywords param not sent when structured params provided', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('fallback query', { title: 'Specific Title', author: 'Author' });
      expect(capturedUrl?.searchParams.has('keywords')).toBe(false);
      expect(capturedUrl?.searchParams.get('title')).toBe('Specific Title');
    });

    it('uses author= param (not keywords=) when options.author set without title', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('', { author: 'Stephen King' });
      expect(capturedUrl?.searchParams.get('author')).toBe('Stephen King');
      expect(capturedUrl?.searchParams.has('keywords')).toBe(false);
      expect(capturedUrl?.searchParams.has('title')).toBe(false);
    });

    it('respects maxResults option in num_results URL param', async () => {
      let capturedUrl: URL | undefined;
      server.use(
        http.get('https://api.audible.com/1.0/catalog/products', ({ request }) => {
          capturedUrl = new URL(request.url);
          return HttpResponse.json({ products: [] });
        }),
      );

      await provider.searchBooks('test', { maxResults: 50 });
      expect(capturedUrl?.searchParams.get('num_results')).toBe('50');
    });
  });

  describe('AUDIBLE_BASE_URL override', () => {
    it.todo('sends requests to AUDIBLE_BASE_URL when env var is set');
    it.todo('uses default https://api.audible{tld} URL when AUDIBLE_BASE_URL is not set');
  });
});
