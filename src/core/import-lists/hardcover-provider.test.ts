import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { HardcoverProvider } from './hardcover-provider.js';
import { ImportListError } from './errors.js';

const GQL_URL = 'https://api.hardcover.app/v1/graphql';

describe('HardcoverProvider', () => {
  const server = useMswServer();

  describe('fetchItems', () => {
    it('fetches trending items via GraphQL and maps to ImportListItem[]', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          data: {
            trending_books: [
              {
                title: 'The Way of Kings',
                contributions: [{ author: { name: 'Brandon Sanderson' } }],
                identifiers: [{ source: { name: 'amazon' }, value: 'B003P2WO5E' }],
              },
              {
                title: 'Dune',
                contributions: [{ author: { name: 'Frank Herbert' } }],
                identifiers: [],
              },
            ],
          },
        })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ title: 'The Way of Kings', author: 'Brandon Sanderson', asin: 'B003P2WO5E', isbn: undefined });
      expect(items[1]).toEqual({ title: 'Dune', author: 'Frank Herbert', asin: undefined, isbn: undefined });
    });

    it('fetches user shelf items via GraphQL and maps to ImportListItem[]', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          data: {
            user_book_reads: [
              {
                book: {
                  title: 'Project Hail Mary',
                  contributions: [{ author: { name: 'Andy Weir' } }],
                  identifiers: [{ source: { name: 'isbn_13' }, value: '9780593135204' }],
                },
              },
            ],
          },
        })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 2 });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({ title: 'Project Hail Mary', author: 'Andy Weir', asin: undefined, isbn: '9780593135204' });
    });

    // #732 — shelfId must be sent as GraphQL variable, never spliced into the query string
    it('sends shelfId via GraphQL variables, not interpolated into the query', async () => {
      let capturedBody: { query: string; variables?: Record<string, unknown> } | null = null;
      server.use(
        http.post(GQL_URL, async ({ request }) => {
          capturedBody = await request.json() as typeof capturedBody;
          return HttpResponse.json({ data: { user_book_reads: [] } });
        }),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 123 });
      await provider.fetchItems();

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.variables).toEqual({ shelfId: 123 });
      expect(capturedBody!.query).toContain('$shelfId');
      expect(capturedBody!.query).not.toContain('123');
    });

    // #1101 F1 — shelf query must request the new image/description fields
    // (mirror of the trending coverage at "captures image.url ..." below)
    it('shelf query body selects description and image { url }, and maps them to ImportListItem', async () => {
      let capturedBody: { query: string; variables?: Record<string, unknown> } | null = null;
      server.use(
        http.post(GQL_URL, async ({ request }) => {
          capturedBody = await request.json() as typeof capturedBody;
          return HttpResponse.json({
            data: {
              user_book_reads: [{
                book: {
                  title: 'Shelf Book',
                  description: 'Shelf blurb.',
                  image: { url: 'https://hardcover.app/shelf-cover.jpg' },
                  contributions: [{ author: { name: 'Shelf Author' } }],
                  identifiers: [{ source: { name: 'amazon' }, value: 'B_SHELF' }],
                },
              }],
            },
          });
        }),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 5 });
      const items = await provider.fetchItems();

      // Query-shape assertion: deleting description or image from SHELF_QUERY
      // would make these fail (the F1 regression guard).
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.query).toContain('user_book_reads');
      expect(capturedBody!.query).toContain('description');
      expect(capturedBody!.query).toContain('image { url }');

      // Mapping assertion: shelf-mode responses with image/description flow through
      expect(items).toEqual([{
        title: 'Shelf Book',
        author: 'Shelf Author',
        asin: 'B_SHELF',
        isbn: undefined,
        coverUrl: 'https://hardcover.app/shelf-cover.jpg',
        description: 'Shelf blurb.',
      }]);
    });

    it('does not send shelf query when listType is trending', async () => {
      let capturedBody: { query: string; variables?: Record<string, unknown> } | null = null;
      server.use(
        http.post(GQL_URL, async ({ request }) => {
          capturedBody = await request.json() as typeof capturedBody;
          return HttpResponse.json({ data: { trending_books: [] } });
        }),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toEqual([]);
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.query).toContain('trending_books');
      expect(capturedBody!.query).not.toContain('user_book_reads');
      expect(capturedBody!.variables).toBeUndefined();
    });

    it('returns empty array when no items', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: { trending_books: [] } })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items).toEqual([]);
    });

    it('captures image.url as coverUrl and description from book node (trending query body selects them)', async () => {
      let capturedBody: { query: string; variables?: Record<string, unknown> } | null = null;
      server.use(
        http.post(GQL_URL, async ({ request }) => {
          capturedBody = await request.json() as typeof capturedBody;
          return HttpResponse.json({
            data: {
              trending_books: [{
                title: 'The Way of Kings',
                description: 'Epic fantasy.',
                image: { url: 'https://hardcover.app/img.jpg' },
                contributions: [{ author: { name: 'Brandon Sanderson' } }],
                identifiers: [{ source: { name: 'amazon' }, value: 'B003P2WO5E' }],
              }],
            },
          });
        }),
      );
      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      // Query-shape assertion mirrors the shelf-mode F1 guard above —
      // deleting description or image from TRENDING_QUERY would fail here.
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.query).toContain('trending_books');
      expect(capturedBody!.query).toContain('description');
      expect(capturedBody!.query).toContain('image { url }');

      expect(items[0]).toEqual({
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        asin: 'B003P2WO5E',
        isbn: undefined,
        coverUrl: 'https://hardcover.app/img.jpg',
        description: 'Epic fantasy.',
      });
    });

    it('schema accepts null/missing description and image (Hardcover legitimately omits)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          data: {
            trending_books: [
              { title: 'A', description: null, image: null, contributions: [], identifiers: [] },
              { title: 'B', contributions: [], identifiers: [] }, // image/description missing
            ],
          },
        })),
      );
      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items).toHaveLength(2);
      expect(items[0]!.coverUrl).toBeUndefined();
      expect(items[0]!.description).toBeUndefined();
      expect(items[1]!.coverUrl).toBeUndefined();
      expect(items[1]!.description).toBeUndefined();
    });

    it('ignores plural images array when present (singular image is canonical)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          data: {
            trending_books: [{
              title: 'X',
              image: { url: 'https://canonical.example/cover.jpg' },
              images: [
                { url: 'https://other-edition-1.example/cover.jpg' },
                { url: 'https://other-edition-2.example/cover.jpg' },
              ],
              contributions: [{ author: { name: 'A' } }],
              identifiers: [],
            }],
          },
        })),
      );
      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items[0]!.coverUrl).toBe('https://canonical.example/cover.jpg');
    });

    it('handles GraphQL error response without crash', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          errors: [{ message: 'Rate limited' }],
        })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      await expect(provider.fetchItems()).rejects.toThrow('GraphQL error');
    });
  });

  describe('test', () => {
    it('returns success when API key is valid', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: { __typename: 'query_root' } })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result).toEqual({ success: true });
    });

    it('returns failure for invalid API key', async () => {
      server.use(
        http.post(GQL_URL, () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' })),
      );

      const provider = new HardcoverProvider({ apiKey: 'bad-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid API key');
    });

    it('returns stringified value when fetch throws a non-Error value', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network-string-error'));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: network-string-error');

      vi.unstubAllGlobals();
    });

    it('maps AbortSignal.timeout DOMException to "Connection failed: Request timed out"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: Request timed out');

      vi.unstubAllGlobals();
    });

    it('returns failure for 2xx with GraphQL errors instead of data', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          errors: [{ message: 'Field "_typename" does not exist' }],
        })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/GraphQL error.*Field/);
    });

    it('returns failure for 2xx with both data and errors null', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: null, errors: null })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/no data\.__typename field/i);
    });

    it('returns failure for 2xx with data but missing __typename', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: { other_field: 'x' } })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });

    it('returns failure for 2xx with malformed body shape (string instead of object)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json('html-interstitial')),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });

    it('returns failure for 2xx with errors as wrong type (string)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: { __typename: 'query_root' }, errors: 'not-an-array' })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });
  });

  describe('timeout helper', () => {
    it('fetchItems propagates "Request timed out" when fetch aborts via AbortSignal.timeout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      await expect(provider.fetchItems()).rejects.toThrow('Request timed out');

      vi.unstubAllGlobals();
    });
  });

  describe('schema validation', () => {
    it('throws ImportListError with ZodError cause when errors is a string (not array)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: null, errors: 'not-an-array' })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      const zod = await import('zod');
      expect((err as ImportListError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('treats { data: null, errors: null } as a successful empty list (passthrough handles nullish)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: null, errors: null })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items).toEqual([]);
    });

    it('accepts null for nullish inner fields (title, contributions, identifiers)', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          data: {
            trending_books: [
              { title: null, contributions: null, identifiers: null },
              { title: 'Real Title', contributions: [], identifiers: [] },
            ],
          },
        })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe('Real Title');
    });

    it('passes through unknown extra fields and still maps successfully', async () => {
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({
          data: {
            trending_books: [
              { title: 'X', new_field: 'unknown', contributions: [], identifiers: [] },
            ],
          },
          envelope_extra: 'unknown',
        })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe('X');
    });
  });
});
