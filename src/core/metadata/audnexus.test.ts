import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { AudnexusProvider } from './audnexus.js';
import { MetadataError, RateLimitError, TransientError } from './errors.js';

describe('AudnexusProvider', () => {
  const server = useMswServer();
  let provider: AudnexusProvider;

  beforeEach(() => {
    provider = new AudnexusProvider();
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

    it('populates seriesPrimary on the mapped BookMetadata (#1088 F1)', async () => {
      const book = await provider.getBook('B0030DL4GK');

      expect(book!.seriesPrimary).toEqual(
        { name: 'The Stormlight Archive', position: 1, asin: 'B010XKCR92' },
      );
    });

    it('leaves seriesPrimary undefined when Audnexus has no seriesPrimary block', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B_NOSP',
            title: 'No SeriesPrimary',
            authors: [{ name: 'A' }],
          });
        }),
      );

      const book = await provider.getBook('B_NOSP');
      expect(book!.seriesPrimary).toBeUndefined();
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

    it('throws MetadataError on malformed response that violates the raw schema', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          // runtimeLengthMin must be a number; supplying a string violates audnexusBookSchema.
          return HttpResponse.json({ asin: 'B0030DL4GK', runtimeLengthMin: 'oops' });
        }),
      );

      await expect(provider.getBook('B0030DL4GK')).rejects.toThrow(MetadataError);
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

  describe('getBook — description fallback', () => {
    it('uses description field when summary is absent', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B000TEST',
            title: 'Test Book',
            authors: [{ name: 'Author', asin: 'A001' }],
            description: 'Description text only',
          });
        }),
      );

      const book = await provider.getBook('B000TEST');
      expect(book!.description).toBe('Description text only');
    });

    it('prefers summary over description when both are present', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({
            asin: 'B000TEST',
            title: 'Test Book',
            authors: [{ name: 'Author', asin: 'A001' }],
            summary: 'Summary text',
            description: 'Description text',
          });
        }),
      );

      const book = await provider.getBook('B000TEST');
      expect(book!.description).toBe('Summary text');
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
      expect(book!.series![0]!.position).toBeUndefined();
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

    it('throws TransientError on network error in getBook', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.error();
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
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
      expect(book!.series![0]!.name).toBe('Main Series');
      expect(book!.series![0]!.position).toBe(1);
      expect(book!.series![1]!.name).toBe('Shared Universe');
      expect(book!.series![1]!.position).toBe(5);
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
  });

  describe('TransientError differentiation', () => {
    it('getBook() on 5xx throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
    });

    it('getBook() on 404/no data returns null', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const result = await provider.getBook('B000TEST');
      expect(result).toBeNull();
    });

    it('getBook() on timeout throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', async () => {
          await delay('infinite');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await expect(provider.getBook('B000TEST')).rejects.toThrow(TransientError);
    }, 20000);

    it('getAuthor() on timeout throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', async () => {
          await delay('infinite');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await expect(provider.getAuthor('B001TEST')).rejects.toThrow(TransientError);
    }, 20000);

    it('getAuthor() on network error throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return HttpResponse.error();
        }),
      );

      await expect(provider.getAuthor('B001TEST')).rejects.toThrow(TransientError);
    });

    it('getAuthor() on 5xx throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(provider.getAuthor('B001TEST')).rejects.toThrow(TransientError);
    });

    it('getAuthor() on 404/no data returns null', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const result = await provider.getAuthor('B001TEST');
      expect(result).toBeNull();
    });
  });

  describe('redirect protection', () => {
    it('getBook() on 302 with Location header throws TransientError with redirect message', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://auth.internal/login' },
          });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect((error as TransientError).message).toMatch(/redirect/i);
    });

    it('getAuthor() on 302 with Location header throws TransientError with redirect message', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://auth.internal/login' },
          });
        }),
      );

      const error = await provider.getAuthor('B001TEST').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect((error as TransientError).message).toMatch(/redirect/i);
    });

    it('getBook() on 3xx with no Location header throws TransientError with redirect message', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, { status: 302 });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientError);
      expect((error as TransientError).message).toMatch(/redirect/i);
    });

    it('getBook() on 2xx response returns data normally (regression)', async () => {
      const book = await provider.getBook('B0030DL4GK');
      expect(book).not.toBeNull();
    });
  });

  describe('429 Retry-After parsing', () => {
    it('getBook() 429 with Retry-After header throws RateLimitError with retryAfterMs = header × 1000', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '30' },
          });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(30000);
      expect((error as RateLimitError).provider).toBe('Audnexus');
    });

    it('getBook() 429 without Retry-After header throws RateLimitError with retryAfterMs = 60000', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(60000);
    });

    it('getAuthor() 429 with Retry-After header throws RateLimitError with retryAfterMs = header × 1000', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '45' },
          });
        }),
      );

      const error = await provider.getAuthor('B001H6UJO8').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(45000);
      expect((error as RateLimitError).provider).toBe('Audnexus');
    });

    it('getAuthor() 429 without Retry-After header throws RateLimitError with retryAfterMs = 60000', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => {
          return new HttpResponse(null, { status: 429 });
        }),
      );

      const error = await provider.getAuthor('B001H6UJO8').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(60000);
    });

    it('429 with empty string Retry-After header falls back to 60000', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '' },
          });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(60000);
    });

    it('429 with non-numeric Retry-After header produces NaN retryAfterMs (documents existing behavior)', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': 'not-a-number' },
          });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBeNaN();
    });

    it('429 with zero Retry-After header produces retryAfterMs = 0', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }),
      );

      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).retryAfterMs).toBe(0);
    });
  });

  describe('region query parameter', () => {
    it('getBook() sends ?region=uk when constructed with region uk', async () => {
      const ukProvider = new AudnexusProvider({ region: 'uk' });
      let capturedUrl = '';

      server.use(
        http.get('https://api.audnex.us/books/:asin', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            asin: 'B0030DL4GK',
            title: 'Test Book',
            authors: [{ name: 'Author' }],
          });
        }),
      );

      await ukProvider.getBook('B0030DL4GK');
      expect(capturedUrl).toContain('?region=uk');
    });

    it('getBook() sends ?region=us when constructed with no config (default)', async () => {
      let capturedUrl = '';

      server.use(
        http.get('https://api.audnex.us/books/:asin', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            asin: 'B0030DL4GK',
            title: 'Test Book',
            authors: [{ name: 'Author' }],
          });
        }),
      );

      await provider.getBook('B0030DL4GK');
      expect(capturedUrl).toContain('?region=us');
    });

    it('getAuthor() sends ?region=ca when constructed with region ca', async () => {
      const caProvider = new AudnexusProvider({ region: 'ca' });
      let capturedUrl = '';

      server.use(
        http.get('https://api.audnex.us/authors/:asin', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            asin: 'B001H6UJO8',
            name: 'Test Author',
          });
        }),
      );

      await caProvider.getAuthor('B001H6UJO8');
      expect(capturedUrl).toContain('?region=ca');
    });

    it('getAuthor() sends ?region=us when constructed with no config (default)', async () => {
      let capturedUrl = '';

      server.use(
        http.get('https://api.audnex.us/authors/:asin', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            asin: 'B001H6UJO8',
            name: 'Test Author',
          });
        }),
      );

      await provider.getAuthor('B001H6UJO8');
      expect(capturedUrl).toContain('?region=us');
    });
  });

  describe('schema validation', () => {
    it('throws MetadataError with ZodError cause when response is non-object', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => HttpResponse.json('not-an-object')),
      );

      const err = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetadataError);
      const zod = await import('zod');
      expect((err as MetadataError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws MetadataError when authors is non-array', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => HttpResponse.json({ asin: 'X', authors: 'broken' })),
      );

      const err = await provider.getBook('X').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MetadataError);
    });

    it('passes through unknown extra fields and still maps successfully', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => HttpResponse.json({
          asin: 'X', title: 'T', authors: [{ name: 'A' }], futureField: 'unknown',
        })),
      );

      const book = await provider.getBook('X');
      expect(book?.title).toBe('T');
    });

    it('getBook accepts null for nullish fields (subtitle, isbn, image, runtimeLengthMin)', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => HttpResponse.json({
          asin: 'B0030DL4GK',
          isbn: null,
          title: 'Null-Field Book',
          subtitle: null,
          authors: [{ name: 'Author', asin: null }],
          narrators: null,
          seriesPrimary: null,
          seriesSecondary: null,
          summary: null,
          description: null,
          publisherName: null,
          releaseDate: null,
          language: null,
          image: null,
          runtimeLengthMin: null,
          genres: null,
        })),
      );

      const book = await provider.getBook('B0030DL4GK');
      expect(book).not.toBeNull();
      expect(book!.title).toBe('Null-Field Book');
      expect(book!.subtitle).toBeUndefined();
      expect(book!.coverUrl).toBeUndefined();
      expect(book!.duration).toBeUndefined();
    });

    it('getAuthor accepts null for nullish fields (description, image, genres)', async () => {
      server.use(
        http.get('https://api.audnex.us/authors/:asin', () => HttpResponse.json({
          asin: 'B001H6UJO8',
          name: 'Null-Field Author',
          description: null,
          image: null,
          genres: null,
        })),
      );

      const author = await provider.getAuthor('B001H6UJO8');
      expect(author).not.toBeNull();
      expect(author!.name).toBe('Null-Field Author');
      expect(author!.imageUrl).toBeUndefined();
    });
  });
});
