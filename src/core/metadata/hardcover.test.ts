import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HardcoverClient } from './hardcover.js';
import { RateLimitError, TransientError, MetadataError } from './errors.js';

describe('HardcoverClient', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildJsonResponse(body: unknown, init: Partial<ResponseInit> = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
  }

  // Hardcover's docs surface the auth header value as `Bearer <token>`; users
  // routinely paste the visible string verbatim. The constructor strips a
  // leading `Bearer ` (case-insensitive) and trims surrounding whitespace so
  // both the production resolver path and the settings test endpoint normalize
  // before the key reaches the outbound Authorization header. See #1138 Bug 1.
  describe('Constructor apiKey normalization', () => {
    function getStoredKey(client: HardcoverClient): string {
      return (client as unknown as { apiKey: string }).apiKey;
    }

    it.each([
      ['Bearer eyJabc', 'eyJabc'],
      ['bearer eyJabc', 'eyJabc'],
      ['BEARER eyJabc', 'eyJabc'],
      ['Bearer  eyJabc', 'eyJabc'],
      ['  Bearer eyJabc  ', 'eyJabc'],
    ])('strips a leading Bearer prefix from %j', (input, expected) => {
      expect(getStoredKey(new HardcoverClient(input))).toBe(expected);
    });

    it('trims surrounding whitespace around a bare token', () => {
      expect(getStoredKey(new HardcoverClient('  eyJabc  \n'))).toBe('eyJabc');
    });

    it('preserves whitespace inside the key body', () => {
      expect(getStoredKey(new HardcoverClient('eyJ\nabc'))).toBe('eyJ\nabc');
    });

    it('reduces bare "Bearer " (with trailing space) to an empty string', () => {
      expect(getStoredKey(new HardcoverClient('Bearer '))).toBe('');
    });

    it('reduces bare "Bearer" (no separator) to an empty string', () => {
      expect(getStoredKey(new HardcoverClient('Bearer'))).toBe('');
    });

    it('preserves an empty input as an empty string without throwing', () => {
      expect(() => new HardcoverClient('')).not.toThrow();
      expect(getStoredKey(new HardcoverClient(''))).toBe('');
    });

    it('uses the normalized key in the outbound Authorization header', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ data: { series: [] } }));
      const client = new HardcoverClient('Bearer eyJabc');
      await client.getSeriesMembers('A', 'X');
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer eyJabc');
    });
  });

  describe('Authorization header + $today', () => {
    it('sends the API key as a Bearer token and stamps the current date', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ data: { series: [] } }));
      const client = new HardcoverClient('TEST_KEY');
      await client.getSeriesMembers('The Band', 'Nicholas Eames');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const args = fetchMock.mock.calls[0]!;
      const init = args[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer TEST_KEY');
      const body = JSON.parse(init.body as string);
      expect(body.variables.name).toBe('The Band');
      expect(body.variables.author).toBe('Nicholas Eames');
      expect(typeof body.variables.today).toBe('string');
      expect(body.variables.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('GetSeriesMembersById sends the cached id and $today', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ data: { series: [] } }));
      const client = new HardcoverClient('K');
      await client.getSeriesMembersById(42);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.variables.id).toBe(42);
      expect(body.variables.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('Response shape', () => {
    it('surfaces series.author.name on the resolved series object', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({
        data: {
          series: [{
            id: 5523,
            name: 'The Band',
            slug: 'the-band',
            author: { name: 'Nicholas Eames' },
            book_series: [],
          }],
        },
      }));
      const result = await new HardcoverClient('K').getSeriesMembers('The Band', 'Nicholas Eames');
      expect(result?.authorName).toBe('Nicholas Eames');
    });

    it('returns null when Hardcover responds with empty series array (resolution miss)', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ data: { series: [] } }));
      const result = await new HardcoverClient('K').getSeriesMembers('Unknown', 'Unknown');
      expect(result).toBeNull();
    });

    it('returns the first match when multiple series rows come back', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({
        data: {
          series: [
            { id: 1, name: 'A', slug: 'a', author: { name: 'X' }, book_series: [] },
            { id: 2, name: 'B', slug: 'b', author: { name: 'Y' }, book_series: [] },
          ],
        },
      }));
      const result = await new HardcoverClient('K').getSeriesMembers('A', 'X');
      expect(result?.id).toBe(1);
    });

    it('handles image:null on a member without throwing — surfaces imageUrl: null', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({
        data: {
          series: [{
            id: 1, name: 'A', slug: 'a', author: { name: 'X' },
            book_series: [{ position: 1, book: { id: 101, slug: 'book', title: 'Book', image: null, users_count: 10 } }],
          }],
        },
      }));
      const result = await new HardcoverClient('K').getSeriesMembers('A', 'X');
      expect(result!.members[0]!.imageUrl).toBeNull();
    });
  });

  describe('searchSeries — Typesense / Algolia hit extraction', () => {
    function buildSearchResponse(results: unknown): Response {
      return buildJsonResponse({ data: { search: { results } } });
    }

    // Primary: Hardcover migrated search from Algolia to Typesense, which nests
    // every field under a `document` key alongside `highlight` / `text_match`
    // siblings, and returns `id` as a string. See #1206.
    it('unwraps a Typesense `document`-enveloped hit and coerces the string id', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        {
          document: {
            id: '3384',
            name: 'Star Wars: Aftermath',
            author: { id: 252077, name: 'Chuck Wendig', slug: 'chuck-wendig' },
            author_name: 'Chuck Wendig',
            books_count: 10,
            primary_books_count: 12,
            slug: 'star-wars-aftermath',
          },
          highlight: {},
          highlights: [],
          text_match: 2312633571820437500,
          text_match_info: {},
        },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('star wars aftermath');
      expect(candidates).toEqual([
        { id: 3384, name: 'Star Wars: Aftermath', slug: 'star-wars-aftermath', authorName: 'Chuck Wendig', booksCount: 10 },
      ]);
      // id is coerced from the string "3384" to the number 3384.
      expect(typeof candidates[0]!.id).toBe('number');
    });

    it('resolves authorName from singular `author_name` when no `author` object is present', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        { document: { id: '7', name: 'Solo Series', author_name: 'Lone Writer', books_count: 3, slug: 'solo-series' } },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('solo');
      expect(candidates[0]!.authorName).toBe('Lone Writer');
    });

    it('still maps a legacy Algolia top-level hit (no `document` key)', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        { id: 5523, name: 'The Band', author: { name: 'Nicholas Eames' }, books_count: 3, slug: 'the-band' },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('the band');
      expect(candidates).toEqual([
        { id: 5523, name: 'The Band', slug: 'the-band', authorName: 'Nicholas Eames', booksCount: 3 },
      ]);
    });

    it('still resolves authorName from the legacy `author_names` plural array', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        { id: 9, name: 'Plural Series', author_names: ['Array Author'], books_count: 2, slug: 'plural-series' },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('plural');
      expect(candidates[0]!.authorName).toBe('Array Author');
    });

    it('parses `{ hits: [...] }` and `{ results: [...] }` array-level envelopes', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse({ hits: [{ document: { id: '1', name: 'H', slug: 'h' } }] }));
      const fromHits = await new HardcoverClient('K').searchSeries('h');
      expect(fromHits[0]!.id).toBe(1);

      fetchMock.mockResolvedValueOnce(buildSearchResponse({ results: [{ document: { id: '2', name: 'R', slug: 'r' } }] }));
      const fromResults = await new HardcoverClient('K').searchSeries('r');
      expect(fromResults[0]!.id).toBe(2);
    });

    it('drops a hit missing id or name', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        { document: { name: 'No Id', slug: 'no-id' } },
        { document: { id: '50', slug: 'no-name' } },
        { document: { id: '51', name: 'Keeper', slug: 'keeper', books_count: 1 } },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('partial');
      expect(candidates).toEqual([
        { id: 51, name: 'Keeper', slug: 'keeper', authorName: null, booksCount: 1 },
      ]);
    });

    it('returns [] for an empty results array', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([]));
      expect(await new HardcoverClient('K').searchSeries('nothing')).toEqual([]);
    });
  });

  describe('Error mapping', () => {
    it('maps HTTP 429 to RateLimitError', async () => {
      fetchMock.mockResolvedValueOnce(new Response('rate-limited', { status: 429, headers: { 'Retry-After': '30' } }));
      await expect(new HardcoverClient('K').getSeriesMembers('A', 'X')).rejects.toBeInstanceOf(RateLimitError);
    });

    it('maps HTTP 5xx to TransientError', async () => {
      fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
      await expect(new HardcoverClient('K').getSeriesMembers('A', 'X')).rejects.toBeInstanceOf(TransientError);
    });

    it('maps GraphQL errors[] to MetadataError', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ errors: [{ message: 'schema mismatch' }] }));
      await expect(new HardcoverClient('K').getSeriesMembers('A', 'X')).rejects.toBeInstanceOf(MetadataError);
    });

    it('maps a network/timeout failure to TransientError', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(new HardcoverClient('K').getSeriesMembers('A', 'X')).rejects.toBeInstanceOf(TransientError);
    });
  });
});
