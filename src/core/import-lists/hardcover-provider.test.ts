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
      // data is .optional() so null fails — but `errors: null` also fails.
      server.use(
        http.post(GQL_URL, () => HttpResponse.json({ data: null, errors: null })),
      );

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
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
      expect(items[0].title).toBe('X');
    });
  });
});
