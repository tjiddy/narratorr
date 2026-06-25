import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { HardcoverProvider } from './hardcover-provider.js';
import { ImportListError } from './errors.js';

const GQL_URL = 'https://api.hardcover.app/v1/graphql';

type GqlBody = { query: string; variables?: Record<string, unknown> };

const isTrendingIdsQuery = (query: string): boolean => query.includes('books_trending');
const isBooksByIdsQuery = (query: string): boolean => query.includes('books(where');

// Branches a single POST URL on the request body's `query` string so the two
// trending legs (`books_trending` then `books(where...)`) get the right payload.
function trendingTwoStep(opts: {
  ids: unknown;
  books?: unknown;
  onIds?: (body: GqlBody) => void;
  onBooks?: (body: GqlBody) => void;
}) {
  return http.post(GQL_URL, async ({ request }) => {
    const body = await request.json() as GqlBody;
    if (isTrendingIdsQuery(body.query)) {
      opts.onIds?.(body);
      return HttpResponse.json({ data: { books_trending: { ids: opts.ids } } });
    }
    if (isBooksByIdsQuery(body.query)) {
      opts.onBooks?.(body);
      return HttpResponse.json({ data: { books: opts.books ?? [] } });
    }
    return HttpResponse.json({ data: {} });
  });
}

describe('HardcoverProvider', () => {
  const server = useMswServer();

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('fetchItems — trending (two-step)', () => {
    it('fetches ids then books and maps, preferring the audio-edition asin over print', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2],
        books: [
          {
            id: 1,
            title: 'Project Hail Mary',
            description: 'Space.',
            image: { url: 'https://hc.app/phm.jpg' },
            contributions: [{ author: { name: 'Andy Weir' } }],
            default_audio_edition: { asin: 'B08G9XR74C', isbn_13: '9780593135228' },
            editions: [{ asin: 'PRINT_ASIN', isbn_13: '9780593135204' }],
          },
          {
            id: 2,
            title: 'Dungeon Crawler Carl',
            contributions: [{ author: { name: 'Matt Dinniman' } }],
            default_audio_edition: { asin: 'B08JF5KSQH' },
            editions: [],
          },
        ],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        asin: 'B08G9XR74C', // audio edition wins over print PRINT_ASIN
        isbn: '9780593135228',
        coverUrl: 'https://hc.app/phm.jpg',
        description: 'Space.',
      });
      expect(items[1]).toEqual({
        title: 'Dungeon Crawler Carl',
        author: 'Matt Dinniman',
        asin: 'B08JF5KSQH',
        isbn: undefined,
        coverUrl: undefined,
        description: undefined,
      });
    });

    it('re-sorts books into the original ids rank order and drops ids with no row (AC1)', async () => {
      server.use(trendingTwoStep({
        ids: [10, 20, 30],
        // Returned out of order, and id 20 is absent from the books response.
        books: [
          { id: 30, title: 'Third', contributions: [] },
          { id: 10, title: 'First', contributions: [] },
        ],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      // Rank order 10, 30 preserved; missing id 20 dropped (no hole).
      expect(items.map((i) => i.title)).toEqual(['First', 'Third']);
    });

    it('sends a YYYY-MM-DD from/to window computed from the current clock (AC2)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-24T12:34:56.000Z'));

      let idsBody: GqlBody | null = null;
      server.use(trendingTwoStep({ ids: [], onIds: (b) => { idsBody = b; } }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      await provider.fetchItems();

      expect(idsBody).not.toBeNull();
      // 7-day window ending today; bare dates, not full ISO timestamps.
      expect(idsBody!.variables).toMatchObject({ from: '2026-06-17', to: '2026-06-24', limit: 50, offset: 0 });
    });

    it('skips the second query and returns [] when ids is empty (AC3)', async () => {
      let postCount = 0;
      server.use(http.post(GQL_URL, async ({ request }) => {
        postCount += 1;
        const body = await request.json() as GqlBody;
        if (isBooksByIdsQuery(body.query)) throw new Error('second query must not run for empty ids');
        return HttpResponse.json({ data: { books_trending: { ids: [] } } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toEqual([]);
      expect(postCount).toBe(1);
    });

    it('skips the second query and returns [] when ids is null (AC3)', async () => {
      let postCount = 0;
      server.use(http.post(GQL_URL, async ({ request }) => {
        postCount += 1;
        const body = await request.json() as GqlBody;
        if (isBooksByIdsQuery(body.query)) throw new Error('second query must not run for null ids');
        return HttpResponse.json({ data: { books_trending: { ids: null } } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toEqual([]);
      expect(postCount).toBe(1);
    });

    // Distinct from the null case: `ids` absent entirely (the field is omitted, not
    // explicitly null). A schema regression from `.nullish()` to nullable-only would
    // let the null case pass while this one threw instead of returning [] (F1).
    it('skips the second query and returns [] when ids is missing entirely (AC3)', async () => {
      let postCount = 0;
      server.use(http.post(GQL_URL, async ({ request }) => {
        postCount += 1;
        const body = await request.json() as GqlBody;
        if (isBooksByIdsQuery(body.query)) throw new Error('second query must not run for missing ids');
        return HttpResponse.json({ data: { books_trending: {} } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toEqual([]);
      expect(postCount).toBe(1);
    });

    it('the books leg selects the shared projection fields (image/description) and maps them', async () => {
      let booksBody: GqlBody | null = null;
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'The Way of Kings',
          description: 'Epic fantasy.',
          image: { url: 'https://hc.app/wok.jpg' },
          contributions: [{ author: { name: 'Brandon Sanderson' } }],
          editions: [{ asin: 'B003P2WO5E' }],
        }],
        onBooks: (b) => { booksBody = b; },
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(booksBody).not.toBeNull();
      expect(booksBody!.query).toContain('description');
      expect(booksBody!.query).toContain('image { url }');
      expect(booksBody!.query).toContain('default_audio_edition');
      expect(items[0]).toEqual({
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
        asin: 'B003P2WO5E',
        isbn: undefined,
        coverUrl: 'https://hc.app/wok.jpg',
        description: 'Epic fantasy.',
      });
    });
  });

  describe('fetchItems — shelf', () => {
    it('queries user_books and maps each entry.book to an ImportListItem (AC4)', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({
        data: {
          user_books: [{
            book: {
              id: 7,
              title: 'Project Hail Mary',
              description: 'Shelf blurb.',
              image: { url: 'https://hc.app/shelf.jpg' },
              contributions: [{ author: { name: 'Andy Weir' } }],
              default_audio_edition: { asin: 'B08G9XR74C' },
              editions: [],
            },
          }],
        },
      })));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 3 });
      const items = await provider.fetchItems();

      expect(items).toEqual([{
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        asin: 'B08G9XR74C',
        isbn: undefined,
        coverUrl: 'https://hc.app/shelf.jpg',
        description: 'Shelf blurb.',
      }]);
    });

    // #732 — shelfId must be a GraphQL variable, never spliced into the query string.
    it('sends shelfId as the status_id variable, not interpolated into the query (AC4)', async () => {
      let capturedBody: GqlBody | null = null;
      server.use(http.post(GQL_URL, async ({ request }) => {
        capturedBody = await request.json() as GqlBody;
        return HttpResponse.json({ data: { user_books: [] } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 123 });
      await provider.fetchItems();

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.variables).toMatchObject({ statusId: 123 });
      expect(capturedBody!.query).toContain('$statusId');
      expect(capturedBody!.query).not.toContain('123');
    });

    // AC4 — bearer-scoped contract: no user_id arg, no `me {` nesting.
    it('shelf query filters on status_id only — no user_id arg and no me nesting (AC4)', async () => {
      let capturedBody: GqlBody | null = null;
      server.use(http.post(GQL_URL, async ({ request }) => {
        capturedBody = await request.json() as GqlBody;
        return HttpResponse.json({ data: { user_books: [] } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 3 });
      await provider.fetchItems();

      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.query).toContain('user_books');
      expect(capturedBody!.query).toContain('status_id');
      expect(capturedBody!.query).not.toContain('user_id');
      expect(capturedBody!.query).not.toContain('me {');
    });
  });

  describe('mapBook — identifier resolution', () => {
    it('falls back to print editions[] when there is no default_audio_edition (AC5)', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Print Only',
          contributions: [],
          editions: [{ asin: 'PRINT_ASIN', isbn_10: '0593135202' }],
        }],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items[0]!.asin).toBe('PRINT_ASIN');
      expect(items[0]!.isbn).toBe('0593135202'); // isbn_10 fallback when no isbn_13
    });

    it('yields undefined asin/isbn (not null, not a crash) when no editions exist (AC5)', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2],
        books: [
          { id: 1, title: 'No Editions', contributions: [] }, // both edition fields missing
          { id: 2, title: 'Empty Editions', contributions: [], editions: [] },
        ],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items[0]!.asin).toBeUndefined();
      expect(items[0]!.isbn).toBeUndefined();
      expect(items[1]!.asin).toBeUndefined();
      expect(items[1]!.isbn).toBeUndefined();
    });

    it('prefers default_audio_edition isbn_13 over isbn_10 and over print editions', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Isbn Pref',
          contributions: [],
          default_audio_edition: { isbn_13: '9780000000001', isbn_10: '0000000001' },
          editions: [{ isbn_13: '9781111111111' }],
        }],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items[0]!.isbn).toBe('9780000000001');
    });
  });

  // ── #1634 Layer 1 — prefer the audio-edition cover over the print cover ──
  describe('mapBook — cover resolution (#1634)', () => {
    it('prefers the default_audio_edition cover over the book (print) image', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Audio Cover',
          contributions: [],
          image: { url: 'https://hc.app/print.jpg' },
          default_audio_edition: { asin: 'B0AUDIO', image: { url: 'https://hc.app/audio.jpg' } },
        }],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items[0]!.coverUrl).toBe('https://hc.app/audio.jpg');
    });

    it('requests the audio-edition image in the GraphQL query', async () => {
      let booksBody: GqlBody | undefined;
      server.use(trendingTwoStep({
        ids: [1],
        books: [{ id: 1, title: 'X', contributions: [] }],
        onBooks: (body) => { booksBody = body; },
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      await provider.fetchItems();
      expect(booksBody!.query).toContain('default_audio_edition { asin isbn_13 isbn_10 image { url } }');
    });

    it('falls back to the print image when the audio edition has no image', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'No Audio Cover',
          contributions: [],
          image: { url: 'https://hc.app/print.jpg' },
          default_audio_edition: { asin: 'B0AUDIO' }, // no image field
        }],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items[0]!.coverUrl).toBe('https://hc.app/print.jpg');
    });

    it('falls back to the print image when the audio-edition image url is null', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Null Audio Cover Url',
          contributions: [],
          image: { url: 'https://hc.app/print.jpg' },
          default_audio_edition: { asin: 'B0AUDIO', image: { url: null } },
        }],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items[0]!.coverUrl).toBe('https://hc.app/print.jpg');
    });

    it('falls back to the print image when there is no audio edition at all', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Print Only Cover',
          contributions: [],
          image: { url: 'https://hc.app/print.jpg' },
          default_audio_edition: null,
        }],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();
      expect(items[0]!.coverUrl).toBe('https://hc.app/print.jpg');
    });
  });

  describe('schema resilience (nullish + passthrough)', () => {
    it('accepts null/missing subtitle, description, image, contributions, editions', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2],
        books: [
          { id: 1, title: 'A', subtitle: null, description: null, image: null, contributions: null, editions: null, default_audio_edition: null },
          { id: 2, title: 'B' }, // everything optional missing
        ],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ title: 'A', author: undefined, asin: undefined, isbn: undefined, coverUrl: undefined, description: undefined });
      expect(items[1]!.title).toBe('B');
    });

    it('passes through unknown extra fields and filters out books with no title', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2],
        books: [
          { id: 1, title: 'X', new_field: 'unknown', contributions: [] },
          { id: 2, title: null, contributions: [] }, // dropped (no title)
        ],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe('X');
    });

    it('throws ImportListError carrying the dotted Zod path for a malformed data shape', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({ data: { books_trending: 'not-an-object' } })));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      expect((err as ImportListError).message).toMatch(/Hardcover returned unexpected response: data/);
    });

    it('throws with a ZodError cause and dotted path when errors is the wrong type', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({ data: null, errors: 'not-an-array' })));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      const zod = await import('zod');
      expect((err as ImportListError).cause).toBeInstanceOf(zod.ZodError);
      expect((err as ImportListError).message).toMatch(/Hardcover returned unexpected response: errors/);
    });

    it('fetchItems message has no leading ": " artifact for a top-level (empty-path) failure', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json('not-an-object')));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const err = await provider.fetchItems().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportListError);
      expect((err as ImportListError).message).not.toContain('response: :');
    });
  });

  describe('GraphQL errors[]', () => {
    it('throws ImportListError with the first error message (AC9)', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({ errors: [{ message: 'Rate limited' }] })));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      await expect(provider.fetchItems()).rejects.toThrow('Hardcover GraphQL error: Rate limited');
    });
  });

  describe('timeout helper', () => {
    it('fetchItems propagates "Request timed out" when fetch aborts via AbortSignal.timeout', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      await expect(provider.fetchItems()).rejects.toThrow('Request timed out');
    });
  });

  describe('test() — real-query probe (AC8)', () => {
    it('issues a real books_trending probe (limit 1) and returns success on a well-formed response', async () => {
      let capturedBody: GqlBody | null = null;
      server.use(http.post(GQL_URL, async ({ request }) => {
        capturedBody = await request.json() as GqlBody;
        return HttpResponse.json({ data: { books_trending: { ids: [1] } } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();

      expect(result).toEqual({ success: true });
      expect(capturedBody!.query).toContain('books_trending');
      expect(capturedBody!.query).not.toContain('__typename');
      expect(capturedBody!.variables).toMatchObject({ limit: 1 });
    });

    it('issues the shelf query (limit 1) with the status_id variable for shelf list type', async () => {
      let capturedBody: GqlBody | null = null;
      server.use(http.post(GQL_URL, async ({ request }) => {
        capturedBody = await request.json() as GqlBody;
        return HttpResponse.json({ data: { user_books: [] } });
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 3 });
      const result = await provider.test();

      expect(result).toEqual({ success: true });
      expect(capturedBody!.query).toContain('user_books');
      expect(capturedBody!.variables).toMatchObject({ statusId: 3, limit: 1 });
    });

    // The regression guard for the "green test, broken preview" class of bug.
    it('returns success:false with the GraphQL error message when the queried field is missing', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({
        errors: [{ message: "field 'trending_books' not found in type: 'query_root'" }],
      })));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/GraphQL error.*not found/);
    });

    it('returns failure for invalid API key (401)', async () => {
      server.use(http.post(GQL_URL, () => new HttpResponse(null, { status: 401, statusText: 'Unauthorized' })));

      const provider = new HardcoverProvider({ apiKey: 'bad-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid API key');
    });

    it('returns failure for invalid API key (403)', async () => {
      server.use(http.post(GQL_URL, () => new HttpResponse(null, { status: 403, statusText: 'Forbidden' })));

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
    });

    it('maps AbortSignal.timeout DOMException to "Connection failed: Request timed out"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'TimeoutError')));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed: Request timed out');
    });

    it('returns failure with validation message for a malformed body shape', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json('html-interstitial')));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const result = await provider.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/validation failed/i);
    });
  });
});
