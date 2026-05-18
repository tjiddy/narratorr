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
