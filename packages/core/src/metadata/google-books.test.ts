import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { GoogleBooksProvider } from './google-books.js';
import { RateLimitError } from './errors.js';

describe('GoogleBooksProvider', () => {
  const server = useMswServer();
  let provider: GoogleBooksProvider;

  beforeEach(() => {
    provider = new GoogleBooksProvider({ apiKey: 'test-api-key' });
  });

  describe('searchBooks', () => {
    it('returns books mapped from Google Books API', async () => {
      const books = await provider.searchBooks('Brandon Sanderson');

      expect(books).toHaveLength(2);
      expect(books[0].title).toBe('The Way of Kings');
      expect(books[0].subtitle).toBe('Book One of the Stormlight Archive');
      expect(books[0].authors).toEqual([{ name: 'Brandon Sanderson' }]);
      expect(books[0].providerId).toBe('3MafDwAAQBAJ');
    });

    it('extracts ISBN_13 from industry identifiers', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].isbn).toBe('9780765365279');
    });

    it('uses HTTPS for cover URLs', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].coverUrl).toMatch(/^https:\/\//);
    });

    it('sanitizes HTML from descriptions', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].description).not.toContain('<b>');
      expect(books[0].description).not.toContain('<i>');
      expect(books[0].description).toContain('Brandon Sanderson');
    });

    it('maps genres from categories', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].genres).toEqual(['Fiction', 'Fantasy']);
    });

    it('returns empty array on API error', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return HttpResponse.json({}, { status: 500 });
        }),
      );

      const books = await provider.searchBooks('test');
      expect(books).toEqual([]);
    });

    it('returns empty array when no items in response', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return HttpResponse.json({ totalItems: 0 });
        }),
      );

      const books = await provider.searchBooks('nonexistent');
      expect(books).toEqual([]);
    });
  });

  describe('search', () => {
    it('returns books and deduplicates authors', async () => {
      const results = await provider.search('Brandon Sanderson');

      expect(results.books).toHaveLength(2);
      // Both books are by Brandon Sanderson — should deduplicate to 1 author
      expect(results.authors).toHaveLength(1);
      expect(results.authors[0].name).toBe('Brandon Sanderson');
      expect(results.series).toEqual([]);
    });
  });

  describe('searchAuthors', () => {
    it('deduplicates authors from search results', async () => {
      const authors = await provider.searchAuthors('Brandon Sanderson');

      // Both fixture books have "Brandon Sanderson" — should deduplicate
      expect(authors.length).toBeGreaterThanOrEqual(1);
      expect(authors[0].name).toBe('Brandon Sanderson');
    });

    it('returns empty on API error', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return HttpResponse.json({}, { status: 500 });
        }),
      );

      const authors = await provider.searchAuthors('test');
      expect(authors).toEqual([]);
    });
  });

  describe('searchSeries', () => {
    it('always returns empty (not supported)', async () => {
      const series = await provider.searchSeries('Stormlight Archive');
      expect(series).toEqual([]);
    });
  });

  describe('getBook', () => {
    it('returns a book by volume ID', async () => {
      const book = await provider.getBook('3MafDwAAQBAJ');

      expect(book).not.toBeNull();
      expect(book!.title).toBe('The Way of Kings');
      expect(book!.providerId).toBe('3MafDwAAQBAJ');
      expect(book!.isbn).toBe('9780765365279');
    });

    it('returns null on API error', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes/:id', () => {
          return HttpResponse.json({}, { status: 404 });
        }),
      );

      const book = await provider.getBook('invalid');
      expect(book).toBeNull();
    });
  });

  describe('getAuthor', () => {
    it('returns null (not supported)', async () => {
      const author = await provider.getAuthor('some-id');
      expect(author).toBeNull();
    });
  });

  describe('getAuthorBooks', () => {
    it('searches by inauthor prefix and returns books', async () => {
      const books = await provider.getAuthorBooks('Brandon Sanderson');

      expect(books).toHaveLength(2);
      expect(books[0].title).toBe('The Way of Kings');
    });

    it('returns empty array on API error', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return HttpResponse.json({}, { status: 500 });
        }),
      );

      const books = await provider.getAuthorBooks('test');
      expect(books).toEqual([]);
    });
  });

  describe('getSeries', () => {
    it('returns null (not supported)', async () => {
      const series = await provider.getSeries('some-id');
      expect(series).toBeNull();
    });
  });

  describe('missing audiobook fields', () => {
    it('returns undefined for ASIN, narrators, and duration', async () => {
      const books = await provider.searchBooks('Way of Kings');

      expect(books[0].asin).toBeUndefined();
      expect(books[0].narrators).toBeUndefined();
      expect(books[0].duration).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('throws RateLimitError on 429 response', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '30' },
          });
        }),
      );

      await expect(provider.searchBooks('test')).rejects.toThrow(RateLimitError);
    });

    it('parses Retry-After header into milliseconds', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '90' },
          });
        }),
      );

      try {
        await provider.searchBooks('test');
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).retryAfterMs).toBe(90000);
        expect((error as RateLimitError).provider).toBe('Google Books');
      }
    });

    it('defaults to 60s when Retry-After header is missing', async () => {
      server.use(
        http.get('https://www.googleapis.com/books/v1/volumes', () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );

      try {
        await provider.searchBooks('test');
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).retryAfterMs).toBe(60000);
      }
    });
  });

  describe('error handling', () => {
    it('handles 403 (invalid API key) gracefully in test()', async () => {
      const badProvider = new GoogleBooksProvider({ apiKey: 'invalid-key' });
      const result = await badProvider.test();

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid');
    });

    it('test() succeeds with valid API key', async () => {
      const result = await provider.test();

      expect(result.success).toBe(true);
      expect(result.message).toContain('Google Books');
    });
  });
});
