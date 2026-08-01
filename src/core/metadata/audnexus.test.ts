import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

    it('429 with a non-numeric Retry-After header falls back to the finite 60000ms default', async () => {
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
      expect((error as RateLimitError).retryAfterMs).toBe(60000);
      expect((error as RateLimitError).retryAfterMs).not.toBeNaN();
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

  /**
   * #1944 — both uncached helpers (`fetchJson` for the author path, `fetchJsonDetailed`
   * for the book path) used to interpret `Retry-After` with an inline
   * `parseInt(header, 10) * 1000`, which yields `NaN` for the HTTP-date form RFC 9110
   * equally permits. A `NaN` window is FALSY at the service's `isRateLimited` gate, so
   * the backoff never engages and a rate-limited Audnexus keeps getting hammered.
   *
   * Both arms now route through the same `parseRetryAfterMs` the chapters path uses.
   * A fix to one helper does not exercise the other, so the whole matrix runs against
   * every public surface that can surface a 429.
   */
  describe('429 retry-window normalization across both helper paths (#1944)', () => {
    function response429(header?: string) {
      return new HttpResponse(null, {
        status: 429,
        ...(header !== undefined && { headers: { 'Retry-After': header } }),
      });
    }

    /** `getBook` → `fetchJsonDetailed`, projected back out as a thrown `RateLimitError`. */
    async function bookWindow(header?: string): Promise<number> {
      server.use(http.get('https://api.audnex.us/books/:asin', () => response429(header)));
      const error = await provider.getBook('B0030DL4GK').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      return (error as RateLimitError).retryAfterMs;
    }

    /** `getBookDetailed` → `fetchJsonDetailed`, as the typed `rate_limited` outcome. */
    async function bookDetailedWindow(header?: string): Promise<number> {
      server.use(http.get('https://api.audnex.us/books/:asin', () => response429(header)));
      const result = await provider.getBookDetailed('B0030DL4GK');
      expect(result.kind).toBe('rate_limited');
      return (result as Extract<typeof result, { kind: 'rate_limited' }>).retryAfterMs;
    }

    /** `getAuthor` → `fetchJson`, the throwing helper. */
    async function authorWindow(header?: string): Promise<number> {
      server.use(http.get('https://api.audnex.us/authors/:asin', () => response429(header)));
      const error = await provider.getAuthor('B001H6UJO8').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitError);
      return (error as RateLimitError).retryAfterMs;
    }

    const SURFACES: [string, (header?: string) => Promise<number>][] = [
      ['getBook (fetchJsonDetailed → thrown RateLimitError)', bookWindow],
      ['getBookDetailed (fetchJsonDetailed → rate_limited outcome)', bookDetailedWindow],
      ['getAuthor (fetchJson → thrown RateLimitError)', authorWindow],
    ];

    describe.each(SURFACES)('%s', (_surface, windowFor) => {
      // The clock is frozen (Date only — `toFake: ['Date']` leaves MSW's and
      // `AbortSignal.timeout`'s real timers alone) so the HTTP-date arm asserts an
      // EXACT window instead of a range: production reads `Date.now()` at a different
      // instant than the test builds the header, and an ambient-clock range assertion
      // cannot distinguish a correct window from a lucky one.
      describe('HTTP-date arm, frozen clock', () => {
        const NOW = Date.parse('2026-07-25T12:00:00.000Z');

        beforeEach(() => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(NOW);
        });
        afterEach(() => { vi.useRealTimers(); });

        it('a FUTURE HTTP-date → exactly the delta to that instant', async () => {
          expect(await windowFor(new Date(NOW + 120_000).toUTCString())).toBe(120_000);
        });

        it('an HTTP-date exactly NOW → a finite 0ms window', async () => {
          expect(await windowFor(new Date(NOW).toUTCString())).toBe(0);
        });

        it('a PAST HTTP-date → the finite 60000ms default, never a negative window', async () => {
          expect(await windowFor(new Date(NOW - 120_000).toUTCString())).toBe(60_000);
        });
      });

      it.each([
        ['absent', undefined],
        ['empty', ''],
        ['non-numeric', 'not-a-number'],
        ['prose', 'later'],
        ['negative', '-30'],
        // Deliberate divergence from `parseInt`, which tolerated trailing garbage and
        // read this as 120000. `parseRetryAfterMs` requires an all-digit token or a
        // parseable date — the stricter reading is the intended one, not a regression.
        ['trailing-garbage', '120abc'],
        // The finiteness guard applies to the PRODUCT, not the operand: `1e306` in
        // digits is a finite Number that overflows to `Infinity` only after `× 1000`,
        // and `Date.now() + Infinity` is a deadline that never expires — the arm that
        // would otherwise pin the backoff gate open for the life of the process.
        ['all-digit overflow after ×1000', `1${'0'.repeat(306)}`],
      ])('Retry-After %s → the finite 60000ms default', async (_label, header) => {
        const retryAfterMs = await windowFor(header);
        expect(retryAfterMs).toBe(60_000);
        expect(Number.isFinite(retryAfterMs)).toBe(true);
      });

      it('Retry-After delay-seconds → seconds × 1000', async () => {
        expect(await windowFor('30')).toBe(30_000);
      });

      it('Retry-After of 0 seconds → a finite 0ms window, not the fallback', async () => {
        expect(await windowFor('0')).toBe(0);
      });

      it('every Retry-After form yields a window MetadataService can honor (finite, non-negative)', async () => {
        // The contract the provider-wide backoff gate depends on, asserted across the
        // whole input space in one place.
        const now = Date.now();
        const headers = [
          undefined,
          '',
          '0',
          '30',
          '-30',
          'not-a-number',
          `1${'0'.repeat(306)}`,
          new Date(now + 120_000).toUTCString(),
          new Date(now - 120_000).toUTCString(),
        ];
        for (const header of headers) {
          const retryAfterMs = await windowFor(header);
          expect(Number.isFinite(retryAfterMs)).toBe(true);
          expect(retryAfterMs).toBeGreaterThanOrEqual(0);
        }
      });
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

  describe('mapBook isbn (#1129)', () => {
    it('surfaces isbn on the mapped BookMetadata when present in raw response', async () => {
      const book = await provider.getBook('B0030DL4GK');
      expect(book!.isbn).toBe('9780765365286');
    });
  });

  describe('getBookDetailed — typed outcomes (#1129)', () => {
    it('200 + valid record → { kind: "ok", book }', async () => {
      const result = await provider.getBookDetailed('B0030DL4GK');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.book.title).toBe('The Way of Kings');
      }
    });

    it('mapped-invalid (missing title/authors) → invalid_record source=mapped', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({ asin: 'B_NO_TITLE', title: '', authors: [] });
        }),
      );
      const result = await provider.getBookDetailed('B_NO_TITLE');
      expect(result.kind).toBe('invalid_record');
      if (result.kind === 'invalid_record') {
        expect(result.source).toBe('mapped');
        expect(Array.isArray(result.issues)).toBe(true);
      }
    });

    it('raw wrapper-schema failure → invalid_record source=raw', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({ asin: 'B0030DL4GK', runtimeLengthMin: 'oops' });
        }),
      );
      const result = await provider.getBookDetailed('B0030DL4GK');
      expect(result.kind).toBe('invalid_record');
      if (result.kind === 'invalid_record') {
        expect(result.source).toBe('raw');
      }
    });

    it('HTTP 404 → not_found', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => new HttpResponse(null, { status: 404 })),
      );
      const result = await provider.getBookDetailed('B_404');
      expect(result.kind).toBe('not_found');
    });

    it('HTTP 429 with Retry-After → rate_limited with retryAfterMs', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '15' } })),
      );
      const result = await provider.getBookDetailed('B_429');
      expect(result.kind).toBe('rate_limited');
      if (result.kind === 'rate_limited') {
        expect(result.retryAfterMs).toBe(15_000);
      }
    });

    it('HTTP 503 → transient_failure', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => new HttpResponse(null, { status: 503 })),
      );
      const result = await provider.getBookDetailed('B_503');
      expect(result.kind).toBe('transient_failure');
    });

    it('network error → transient_failure', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => HttpResponse.error()),
      );
      const result = await provider.getBookDetailed('B_NET');
      expect(result.kind).toBe('transient_failure');
    });

    it('does NOT throw under any error path', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => new HttpResponse(null, { status: 500 })),
      );
      await expect(provider.getBookDetailed('B_5xx')).resolves.toBeDefined();
    });
  });

  describe('legacy getBook wrapper — compatibility matrix (#1129)', () => {
    it('HTTP 429 → wrapper throws RateLimitError', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '5' } })),
      );
      await expect(provider.getBook('B_429')).rejects.toBeInstanceOf(RateLimitError);
    });

    it('HTTP 5xx → wrapper throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => new HttpResponse(null, { status: 502 })),
      );
      await expect(provider.getBook('B_5xx')).rejects.toBeInstanceOf(TransientError);
    });

    it('network error → wrapper throws TransientError', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => HttpResponse.error()),
      );
      await expect(provider.getBook('B_NET')).rejects.toBeInstanceOf(TransientError);
    });

    it('raw wrapper-schema failure → wrapper throws MetadataError', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({ asin: 'B0030DL4GK', runtimeLengthMin: 'oops' });
        }),
      );
      await expect(provider.getBook('B0030DL4GK')).rejects.toBeInstanceOf(MetadataError);
    });

    it('mapped-invalid record → wrapper returns null', async () => {
      server.use(
        http.get('https://api.audnex.us/books/:asin', () => {
          return HttpResponse.json({ asin: 'B_NO_TITLE', title: '', authors: [] });
        }),
      );
      const result = await provider.getBook('B_NO_TITLE');
      expect(result).toBeNull();
    });
  });

  // #1942 — chapter-runtime adapter. The Audnexus chapter table is a strictly
  // more authoritative runtime than the `runtimeLengthMin` scalar; this thin,
  // never-throw lookup is the corroborating second source. Definitive outcomes
  // (`ok` on the requested edition's complete record, `not_found` on a documented
  // 400/404) are the ONLY kinds the service may cache — everything else is transient.
  describe('getChapterRuntime — chapter-runtime adapter (#1942)', () => {
    const FABLEHAVEN = 'B00CXXEX8W';

    /** Live-verified Fablehaven Book 1 chapter record (2026-07-25). */
    function chapterRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        asin: FABLEHAVEN,
        region: 'us',
        runtimeLengthMs: 33219490,
        runtimeLengthSec: 33219,
        isAccurate: true,
        chapters: [{ title: 'Opening Credits', startOffsetMs: 0, lengthMs: 21000 }],
        ...overrides,
      };
    }

    function chaptersHandler(responder: Parameters<typeof http.get>[1]) {
      return http.get('https://api.audnex.us/books/:asin/chapters', responder);
    }

    describe('definitive — the requested edition\'s complete record', () => {
      it('200 with matching asin + chapters array → ok carrying runtimeLengthMs and isAccurate', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord())));

        const result = await provider.getChapterRuntime(FABLEHAVEN);

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.runtimeLengthMs).toBe(33219490);
          expect(result.isAccurate).toBe(true);
        }
      });

      it('a complete record with isAccurate false still parses as ok (the trust gate is the service\'s job)', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord({ isAccurate: false }))));

        const result = await provider.getChapterRuntime(FABLEHAVEN);

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') expect(result.isAccurate).toBe(false);
      });

      it('a complete record with null runtime/trust fields still parses as ok (.nullish external fields)', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord({ runtimeLengthMs: null, isAccurate: null }))));

        const result = await provider.getChapterRuntime(FABLEHAVEN);

        expect(result.kind).toBe('ok');
        if (result.kind === 'ok') {
          expect(result.runtimeLengthMs).toBeNull();
          expect(result.isAccurate).toBeNull();
        }
      });

      it('an empty chapters array still satisfies the shape half of the predicate', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord({ chapters: [] }))));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('ok');
      });

      it.each([400, 404])('documented HTTP %i → not_found', async (status) => {
        server.use(chaptersHandler(() => new HttpResponse(null, { status })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('not_found');
      });
    });

    describe('transient — a 200 that is NOT the requested edition\'s complete record (F18/F20)', () => {
      it('chapters array but MISMATCHED asin → invalid_record (a wrong-edition body is never authoritative)', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord({ asin: 'B_OTHER_EDITION' }))));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('chapters array but ABSENT asin → invalid_record', async () => {
        server.use(chaptersHandler(() => HttpResponse.json({ chapters: [], runtimeLengthMs: 33219490, isAccurate: true })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('matching asin but NO chapters array → invalid_record (partial/error object)', async () => {
        server.use(chaptersHandler(() => HttpResponse.json({ asin: FABLEHAVEN, message: 'temporarily unavailable' })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('matching asin with a null chapters field → invalid_record', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord({ chapters: null }))));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('fieldless {} envelope → invalid_record', async () => {
        server.use(chaptersHandler(() => HttpResponse.json({})));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('HTML interstitial body → invalid_record', async () => {
        server.use(chaptersHandler(() => new HttpResponse('<html><body>Just a moment…</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('empty 200 body → invalid_record', async () => {
        server.use(chaptersHandler(() => new HttpResponse('', { status: 200 })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('JSON primitive body → invalid_record', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(42)));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });

      it('schema-invalid body (runtimeLengthMs is a string) → invalid_record', async () => {
        server.use(chaptersHandler(() => HttpResponse.json(chapterRecord({ runtimeLengthMs: 'oops' }))));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('invalid_record');
      });
    });

    describe('transient — incomplete or inconclusive exchanges (F15/F17/F19)', () => {
      it('post-header body-stream failure → transient_failure, NOT invalid_record', async () => {
        server.use(chaptersHandler(() => {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"asin":"B00CX'));
              controller.error(new Error('stream aborted mid-body'));
            },
          });
          return new HttpResponse(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('transient_failure');
      });

      it.each([401, 403, 408, 410, 422])('unexpected non-success HTTP %i → transient_failure (never not_found)', async (status) => {
        server.use(chaptersHandler(() => new HttpResponse(null, { status })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('transient_failure');
      });

      it.each([202, 204])('ok-but-non-200 HTTP %i → transient_failure (the definitive branch gates on status === 200)', async (status) => {
        server.use(chaptersHandler(() => new HttpResponse(null, { status })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('transient_failure');
      });

      it.each([500, 503])('HTTP %i → transient_failure', async (status) => {
        server.use(chaptersHandler(() => new HttpResponse(null, { status })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('transient_failure');
      });

      it('3xx redirect (thrown by fetchWithTimeout after headers) → transient_failure', async () => {
        server.use(chaptersHandler(() => new HttpResponse(null, { status: 302, headers: { Location: 'https://example.test/login' } })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('transient_failure');
      });

      it('pre-header network failure → transient_failure', async () => {
        server.use(chaptersHandler(() => HttpResponse.error()));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('transient_failure');
      });

      it('never throws on any failure path', async () => {
        server.use(chaptersHandler(() => new HttpResponse(null, { status: 500 })));

        await expect(provider.getChapterRuntime(FABLEHAVEN)).resolves.toBeDefined();
      });
    });

    describe('429 retry-window normalization (F16)', () => {
      /**
       * Read the `retryAfterMs` off a 429 chapters response, asserting the
       * discriminant first so a mis-classified outcome fails loudly here rather
       * than silently skipping the window assertion.
       */
      async function retryAfterMsFor(header?: string): Promise<number> {
        server.use(chaptersHandler(() => new HttpResponse(null, {
          status: 429,
          ...(header !== undefined && { headers: { 'Retry-After': header } }),
        })));

        const result = await provider.getChapterRuntime(FABLEHAVEN);
        expect(result.kind).toBe('rate_limited');
        return (result as Extract<typeof result, { kind: 'rate_limited' }>).retryAfterMs;
      }

      it('Retry-After delay-seconds → seconds × 1000', async () => {
        expect(await retryAfterMsFor('30')).toBe(30_000);
      });

      // The clock is frozen (Date only — `toFake: ['Date']` leaves MSW's and
      // `AbortSignal.timeout`'s real timers alone) so the HTTP-date arm asserts an
      // EXACT window instead of a range: production reads `Date.now()` at a
      // different instant than the test builds the header, and an ambient-clock
      // range assertion cannot distinguish a correct window from a lucky one.
      describe('HTTP-date arm, frozen clock', () => {
        const NOW = Date.parse('2026-07-25T12:00:00.000Z');

        beforeEach(() => {
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(NOW);
        });
        afterEach(() => { vi.useRealTimers(); });

        it('a FUTURE HTTP-date → exactly the delta to that instant', async () => {
          expect(await retryAfterMsFor(new Date(NOW + 120_000).toUTCString())).toBe(120_000);
        });

        it('an HTTP-date exactly NOW → a finite 0ms window', async () => {
          expect(await retryAfterMsFor(new Date(NOW).toUTCString())).toBe(0);
        });

        it('a PAST HTTP-date → the finite 60000ms default, never a negative window', async () => {
          expect(await retryAfterMsFor(new Date(NOW - 120_000).toUTCString())).toBe(60_000);
        });
      });

      it.each([
        ['absent', undefined],
        ['empty', ''],
        ['non-numeric', 'not-a-number'],
        ['negative', '-30'],
      ])('Retry-After %s → the finite 60000ms default', async (_label, header) => {
        const retryAfterMs = await retryAfterMsFor(header);
        expect(retryAfterMs).toBe(60_000);
        expect(retryAfterMs).not.toBeNaN();
      });

      it('Retry-After of 0 seconds → a finite 0ms window', async () => {
        expect(await retryAfterMsFor('0')).toBe(0);
      });

      // F1 — the finiteness guard must apply to the PRODUCT, not the operand.
      // `1e306` is a finite Number written in all digits, so an operand-side
      // `Number.isFinite` check passes it straight through and `× 1000` overflows
      // to Infinity. `setRateLimited(Date.now() + Infinity)` is then a deadline
      // that never expires, permanently suppressing every Audnexus lookup.
      it.each([
        ['overflows only after ×1000 (1e306 in digits)', `1${'0'.repeat(306)}`],
        ['overflows on parse alone (1e400 in digits)', `1${'0'.repeat(400)}`],
        ['Number.MAX_VALUE in digits', BigInt(Number.MAX_SAFE_INTEGER).toString().repeat(40)],
      ])('an all-digit Retry-After that %s → the finite 60000ms default', async (_label, header) => {
        const retryAfterMs = await retryAfterMsFor(header);
        expect(retryAfterMs).toBe(60_000);
        expect(Number.isFinite(retryAfterMs)).toBe(true);
      });

      it('every Retry-After form yields a window MetadataService can honor (finite, non-negative)', async () => {
        // The contract the provider-wide backoff gate depends on, asserted across
        // the whole input space in one place.
        const headers = [undefined, '', '0', '30', '-30', 'not-a-number', `1${'0'.repeat(306)}`];
        for (const header of headers) {
          const retryAfterMs = await retryAfterMsFor(header);
          expect(Number.isFinite(retryAfterMs)).toBe(true);
          expect(retryAfterMs).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe('request shape', () => {
      it('requests /books/{asin}/chapters with the provider\'s configured region', async () => {
        const ukProvider = new AudnexusProvider({ region: 'uk' });
        let capturedUrl = '';
        server.use(chaptersHandler(({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json(chapterRecord());
        }));

        await ukProvider.getChapterRuntime(FABLEHAVEN);

        expect(capturedUrl).toContain(`/books/${FABLEHAVEN}/chapters`);
        expect(capturedUrl).toContain('region=uk');
        expect(capturedUrl).not.toContain('region=us');
      });

      it('defaults to region=us and URL-encodes the ASIN path segment', async () => {
        let capturedUrl = '';
        server.use(chaptersHandler(({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json(chapterRecord({ asin: 'B 0030' }));
        }));

        await provider.getChapterRuntime('B 0030');

        expect(capturedUrl).toContain('/books/B%200030/chapters');
        expect(capturedUrl).toContain('region=us');
      });
    });
  });
});
