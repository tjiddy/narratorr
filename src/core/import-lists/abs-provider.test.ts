import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { AbsProvider } from './abs-provider.js';
import { ImportListError } from './errors.js';

const ABS_BASE = 'https://abs.test';

describe('AbsProvider', () => {
  const server = useMswServer();

  describe('fetchItems', () => {
    it('fetches library items and maps to ImportListItem[]', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, ({ request }) => {
          expect(request.headers.get('Authorization')).toBe('Bearer test-key');
          return HttpResponse.json({
            results: [
              { media: { metadata: { title: 'The Way of Kings', authorName: 'Brandon Sanderson', asin: 'B003P2WO5E' } } },
              { media: { metadata: { title: 'Warbreaker', authorName: 'Brandon Sanderson' } } },
            ],
          });
        }),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ title: 'The Way of Kings', author: 'Brandon Sanderson', asin: 'B003P2WO5E', isbn: undefined });
      expect(items[1]).toEqual({ title: 'Warbreaker', author: 'Brandon Sanderson', asin: undefined, isbn: undefined });
    });

    it('returns empty array when no items', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => HttpResponse.json({ results: [] })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const items = await provider.fetchItems();
      expect(items).toEqual([]);
    });

    it('skips items with null/empty title (tolerated by schema, mapping skips)', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => HttpResponse.json({
          results: [
            { media: { metadata: { title: null, authorName: 'Someone' } } },
            { media: { metadata: { title: 'Valid Book', authorName: 'Author' } } },
          ],
        })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const items = await provider.fetchItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Valid Book');
    });

    it('encodes libraryId in URL path (#786)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      vi.stubGlobal('fetch', fetchMock);

      // Bypass schema validation — schema rejects this in production
      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib/1' });
      await provider.fetchItems();

      expect(fetchMock).toHaveBeenCalledWith(
        `${ABS_BASE}/api/libraries/lib%2F1/items`,
        expect.anything(),
      );

      vi.unstubAllGlobals();
    });

    it('throws on HTTP error', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      await expect(provider.fetchItems()).rejects.toThrow('ABS API returned 500');
    });
  });

  describe('test', () => {
    it('returns success when API key is valid and library exists', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries`, () => HttpResponse.json({
          libraries: [
            { id: 'lib-1', name: 'Audiobooks' },
            { id: 'lib-2', name: 'Podcasts' },
          ],
        })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const result = await provider.test();
      expect(result).toEqual({ success: true });
    });

    it('returns failure when library ID not found', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries`, () => HttpResponse.json({
          libraries: [{ id: 'other', name: 'Other' }],
        })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('returns failure for invalid API key', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries`, () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'bad-key', libraryId: 'lib-1' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns stringified value when fetch throws a non-Error value', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network-string-error'));

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: network-string-error');

      vi.unstubAllGlobals();
    });

    it('maps AbortSignal.timeout DOMException to "Connection failed: Request timed out"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: Request timed out');

      vi.unstubAllGlobals();
    });
  });

  describe('timeout helper', () => {
    it('fetchItems propagates "Request timed out" when fetch aborts via AbortSignal.timeout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      await expect(provider.fetchItems()).rejects.toThrow('Request timed out');

      vi.unstubAllGlobals();
    });
  });

  describe('schema validation', () => {
    it('throws ImportListError with ZodError cause when results is not an array', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => HttpResponse.json({ results: 'broken' })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      const zod = await import('zod');
      expect((err as ImportListError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws ImportListError with ZodError cause when item.media is null (boundary failure)', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => HttpResponse.json({
          results: [{ media: null }],
        })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      const zod = await import('zod');
      expect((err as ImportListError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws ImportListError with ZodError cause when item.media.metadata is null', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => HttpResponse.json({
          results: [{ media: { metadata: null } }],
        })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      const zod = await import('zod');
      expect((err as ImportListError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('test() returns success: false when libraries is missing', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries`, () => HttpResponse.json({})),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });

    it('test() returns success: false when libraries is non-array', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries`, () => HttpResponse.json({ libraries: 'broken' })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });

    it('passes through unknown extra fields and still maps successfully', async () => {
      server.use(
        http.get(`${ABS_BASE}/api/libraries/lib-1/items`, () => HttpResponse.json({
          results: [
            { media: { metadata: { title: 'Book', authorName: 'A', new_field: 'unknown' } }, future_field: 1 },
          ],
          envelope_extra: 'unknown',
        })),
      );

      const provider = new AbsProvider({ serverUrl: ABS_BASE, apiKey: 'test-key', libraryId: 'lib-1' });
      const items = await provider.fetchItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Book');
    });
  });
});
