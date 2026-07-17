import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { HardcoverProvider, type HardcoverConfig } from './hardcover-provider.js';
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

  // ── #1879 — custom list by URL ──────────────────────────────────────────────
  describe('fetchItems — custom list (#1879)', () => {
    const CUSTOM_URL = 'https://hardcover.app/@LisaRae/lists/2025-year-in-books';

    const makeProvider = (overrides: Partial<HardcoverConfig> = {}) =>
      new HardcoverProvider({ apiKey: 'test-key', listType: 'custom', listUrl: CUSTOM_URL, ...overrides });

    const isCustomQuery = (query: string): boolean => query.includes('lists(');

    const row = (id: number, book: unknown = { id, title: `Book ${id}`, contributions: [] }) =>
      ({ id, position: id, book });

    const rowsRange = (start: number, end: number) =>
      Array.from({ length: end - start }, (_, i) => row(start + i));

    const listResponse = (rows: unknown, booksCount: number | null = null, extra: Record<string, unknown> = {}) =>
      ({ data: { lists: [{ id: 1, name: 'L', ranked: true, books_count: booksCount, list_books: rows, ...extra }] } });

    // Serves paged windows from a virtual list of `total` rows, honouring the
    // request `offset`/`limit`. `booksCount` defaults to `total`.
    function pagedHandler(opts: { total: number; booksCount?: number | null; onRequest?: (vars: Record<string, unknown>) => void }) {
      return http.post(GQL_URL, async ({ request }) => {
        const body = await request.json() as GqlBody;
        const vars = body.variables ?? {};
        opts.onRequest?.(vars);
        const offset = Number(vars.offset ?? 0);
        const limit = Number(vars.limit ?? PAGE_SIZE);
        const rows = rowsRange(offset, Math.min(offset + limit, opts.total));
        return HttpResponse.json(listResponse(rows, opts.booksCount === undefined ? opts.total : opts.booksCount));
      });
    }

    // Serves pre-scripted full responses in order, one per request.
    function scriptedHandler(pages: unknown[], onRequest?: (vars: Record<string, unknown>, index: number) => void) {
      let i = 0;
      return http.post(GQL_URL, async ({ request }) => {
        const body = await request.json() as GqlBody;
        onRequest?.(body.variables ?? {}, i);
        const page = pages[Math.min(i, pages.length - 1)] as Record<string, unknown>;
        i += 1;
        return HttpResponse.json(page);
      });
    }

    const PAGE_SIZE = 100;

    // F3 — the provider-level invalid/missing-URL failure (`requireParsedUrl`) is a
    // trust boundary shared by fetchItems() and test(); assert its consequence
    // directly (parser/schema tests don't cover the provider throw) and prove no
    // network request is issued.
    describe('invalid / missing List URL (F3)', () => {
      const guardNoNetwork = () => {
        let hits = 0;
        server.use(http.post(GQL_URL, () => { hits += 1; return HttpResponse.json(listResponse([])); }));
        return () => hits;
      };

      it('fetchItems() rejects with ImportListError and issues no request for an invalid URL', async () => {
        const hits = guardNoNetwork();
        const err = await makeProvider({ listUrl: 'https://example.com/not-hardcover' }).fetchItems().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ImportListError);
        expect((err as ImportListError).message).toBe('Not a Hardcover list URL');
        expect(hits()).toBe(0);
      });

      it('fetchItems() rejects with ImportListError and issues no request for a missing URL', async () => {
        const hits = guardNoNetwork();
        const err = await new HardcoverProvider({ apiKey: 'test-key', listType: 'custom' }).fetchItems().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ImportListError);
        expect((err as ImportListError).message).toBe('Not a Hardcover list URL');
        expect(hits()).toBe(0);
      });

      it('test() returns a failed result and issues no request for an invalid URL', async () => {
        const hits = guardNoNetwork();
        const result = await makeProvider({ listUrl: 'not-a-url' }).test();
        expect(result.success).toBe(false);
        expect(result.message).toContain('Not a Hardcover list URL');
        expect(hits()).toBe(0);
      });
    });

    describe('query shape & variables (AC1, AC6)', () => {
      it('sends citext/String variables, the public gate, and the array-form order_by', async () => {
        let body: GqlBody | null = null;
        server.use(http.post(GQL_URL, async ({ request }) => {
          body = await request.json() as GqlBody;
          return HttpResponse.json(listResponse([]));
        }));

        await makeProvider({ importMax: 50 }).fetchItems();

        expect(body).not.toBeNull();
        expect(isCustomQuery(body!.query)).toBe(true);
        expect(body!.query).toContain('$username: citext!');
        expect(body!.query).toContain('$slug: String!');
        expect(body!.query).toContain('$offset: Int!');
        expect(body!.query).toContain('public: { _eq: true }');
        expect(body!.query).toContain('order_by: [{ position: asc_nulls_last }, { id: asc }]');
        // Parsed from the URL, sent as variables (never interpolated).
        expect(body!.variables).toMatchObject({ username: 'LisaRae', slug: '2025-year-in-books', limit: 50, offset: 0 });
      });

      it('reuses the shared BookFields fragment / mapBook (audio-edition asin + cover) (AC3)', async () => {
        let body: GqlBody | null = null;
        server.use(http.post(GQL_URL, async ({ request }) => {
          body = await request.json() as GqlBody;
          return HttpResponse.json(listResponse([row(7, {
            id: 7,
            title: 'Project Hail Mary',
            description: 'Space.',
            image: { url: 'https://hc.app/print.jpg' },
            contributions: [{ author: { name: 'Andy Weir' } }],
            default_audio_edition: { asin: 'B08G9XR74C', isbn_13: '9780593135228', image: { url: 'https://hc.app/audio.jpg' } },
            editions: [{ asin: 'PRINT_ASIN' }],
          })]));
        }));

        const items = await makeProvider({ importMax: 50 }).fetchItems();

        expect(body!.query).toContain('...BookFields');
        expect(body!.query).toContain('default_audio_edition { asin isbn_13 isbn_10 image { url } }');
        expect(items).toEqual([{
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          asin: 'B08G9XR74C',
          isbn: '9780593135228',
          coverUrl: 'https://hc.app/audio.jpg',
          description: 'Space.',
        }]);
      });
    });

    describe('Import Max — fixed limits (AC4)', () => {
      it('importMax=50 issues a single query with limit 50, offset 0', async () => {
        let count = 0;
        const vars: Record<string, unknown>[] = [];
        server.use(http.post(GQL_URL, async ({ request }) => {
          count += 1;
          const body = await request.json() as GqlBody;
          vars.push(body.variables ?? {});
          return HttpResponse.json(listResponse(rowsRange(0, 50)));
        }));

        const items = await makeProvider({ importMax: 50 }).fetchItems();
        expect(count).toBe(1);
        expect(vars[0]).toMatchObject({ limit: 50, offset: 0 });
        expect(items).toHaveLength(50);
      });

      it('importMax=100 issues a single query with limit 100', async () => {
        let capturedLimit: unknown;
        server.use(http.post(GQL_URL, async ({ request }) => {
          const body = await request.json() as GqlBody;
          capturedLimit = body.variables?.limit;
          return HttpResponse.json(listResponse(rowsRange(0, 100)));
        }));

        const items = await makeProvider({ importMax: 100 }).fetchItems();
        expect(capturedLimit).toBe(100);
        expect(items).toHaveLength(100);
      });

      it('defaults to limit 50 when importMax is omitted', async () => {
        let capturedLimit: unknown;
        server.use(http.post(GQL_URL, async ({ request }) => {
          const body = await request.json() as GqlBody;
          capturedLimit = body.variables?.limit;
          return HttpResponse.json(listResponse(rowsRange(0, 10)));
        }));

        await makeProvider().fetchItems();
        expect(capturedLimit).toBe(50);
      });
    });

    describe("Import Max — 'all' pagination (AC5, AC6)", () => {
      it('pages until a short page, concatenating rows with correct offsets', async () => {
        const offsets: unknown[] = [];
        server.use(pagedHandler({ total: 130, onRequest: (v) => offsets.push(v.offset) }));

        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(offsets).toEqual([0, 100]);
        expect(items).toHaveLength(130);
        expect(items[0]!.title).toBe('Book 0');
        expect(items[129]!.title).toBe('Book 129');
      });

      it('terminates on the empty page after an exact multiple of 100 (no throw)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 100, onRequest: () => { count += 1; } }));

        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(count).toBe(2); // full page (0) then empty page (100)
        expect(items).toHaveLength(100);
      });

      it('first request always fires; budget derives from the first response books_count (F30)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 130, booksCount: 130, onRequest: () => { count += 1; } }));
        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(count).toBe(2);
        expect(items).toHaveLength(130);
      });

      it('null books_count falls back to MAX_LIST_PAGES without breaking the loop (F30)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 130, booksCount: null, onRequest: () => { count += 1; } }));
        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(count).toBe(2);
        expect(items).toHaveLength(130);
      });

      it('4999 rows: 49 full pages + a 99-row short page → returns 4999, no throw (F36a)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 4999, onRequest: () => { count += 1; } }));
        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(count).toBe(50);
        expect(items).toHaveLength(4999);
      });

      it('exactly 5000 rows: 50 full pages + an empty terminal page → returns 5000, no throw (F36b)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 5000, onRequest: () => { count += 1; } }));
        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(count).toBe(51);
        expect(items).toHaveLength(5000);
      });

      it('a 51st FULL page (> 5000 full rows) → deterministic ImportListError, no partial result (F36c)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 5100, booksCount: 5100, onRequest: () => { count += 1; } }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toBeInstanceOf(ImportListError);
        expect(count).toBe(51); // 50 full pages accepted, throws on the 51st full page
      });

      it('a large/corrupt books_count is still clamped at MAX_LIST_PAGES full pages (F34)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 5100, booksCount: 999999, onRequest: () => { count += 1; } }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toThrow(ImportListError);
        expect(count).toBe(51);
      });

      it('books_count-derived budget throws on the first full page beyond it (F28)', async () => {
        let count = 0;
        // books_count 250 → ceil(250/100)=3 full-page budget; server keeps serving full pages.
        server.use(pagedHandler({ total: 500, booksCount: 250, onRequest: () => { count += 1; } }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toThrow(ImportListError);
        expect(count).toBe(4); // 3 full pages accepted, throws on the 4th
      });

      it('advances past a full page with an unmappable row; the row still consumes its id slot (F14)', async () => {
        const page1 = rowsRange(0, 100);
        page1[50] = row(50, { id: 50, title: null, contributions: [] }); // titleless → dropped
        server.use(scriptedHandler([
          listResponse(page1),
          listResponse(rowsRange(100, 120)), // short second page of new rows
        ]));

        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        // 99 mappable from page 1 (row 50 dropped) + 20 from page 2.
        expect(items).toHaveLength(119);
        expect(items.some((i) => i.title === 'Book 50')).toBe(false);
      });

      it('an exact-repeat full page (zero new ids) → deterministic ImportListError (F31)', async () => {
        let count = 0;
        const page = rowsRange(0, 100);
        server.use(scriptedHandler([listResponse(page), listResponse(page)], () => { count += 1; }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toThrow(/repeated page/i);
        expect(count).toBe(2);
      });

      it('partially overlapping full pages are de-duplicated by raw id and continue (F19)', async () => {
        server.use(scriptedHandler([
          listResponse(rowsRange(0, 100)),    // ids 0..99
          listResponse(rowsRange(50, 150)),   // overlap 50..99, new 100..149
          listResponse(rowsRange(150, 170)),  // short
        ]));

        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(items).toHaveLength(170);
        expect(items[0]!.title).toBe('Book 0');
        expect(items[169]!.title).toBe('Book 169');
      });
    });

    describe('list resolution & null/missing dispositions (AC7, AC8)', () => {
      const fetchErr = async (response: Record<string, unknown>) => {
        server.use(http.post(GQL_URL, () => HttpResponse.json(response)));
        return makeProvider({ importMax: 50 }).fetchItems().catch((e: unknown) => e);
      };

      it('lists: [] → "List not found or private" (NOT [])', async () => {
        const err = await fetchErr({ data: { lists: [] } });
        expect(err).toBeInstanceOf(ImportListError);
        expect((err as ImportListError).message).toBe('List not found or private');
      });

      it('resolved-empty list_books: [] → returns [] (distinct from not-found)', async () => {
        server.use(http.post(GQL_URL, () => HttpResponse.json(listResponse([]))));
        await expect(makeProvider({ importMax: 50 }).fetchItems()).resolves.toEqual([]);
      });

      it('lists: null and omitted lists → unexpected-response error', async () => {
        expect(await fetchErr({ data: { lists: null } })).toBeInstanceOf(ImportListError);
        expect(await fetchErr({ data: {} })).toBeInstanceOf(ImportListError);
      });

      it('nested list_books null / omitted → unexpected-response error', async () => {
        expect(await fetchErr({ data: { lists: [{ id: 1, list_books: null }] } })).toBeInstanceOf(ImportListError);
        expect(await fetchErr({ data: { lists: [{ id: 1 }] } })).toBeInstanceOf(ImportListError);
      });

      it('row id null / omitted → unexpected-response error', async () => {
        expect(await fetchErr(listResponse([{ id: null, position: 1, book: { title: 'X' } }]))).toBeInstanceOf(ImportListError);
        expect(await fetchErr(listResponse([{ position: 1, book: { title: 'X' } }]))).toBeInstanceOf(ImportListError);
      });

      it('null/missing/titleless book rows are dropped (not errors); the mappable remainder returns (F32)', async () => {
        server.use(http.post(GQL_URL, () => HttpResponse.json(listResponse([
          row(1, null),
          row(2),                                   // mappable
          { id: 3, position: 3 },                   // omitted book
          row(4, { id: 4, title: null, contributions: [] }), // titleless
        ]))));

        const items = await makeProvider({ importMax: 50 }).fetchItems();
        expect(items).toHaveLength(1);
        expect(items[0]!.title).toBe('Book 2');
      });

      it('surfaces a GraphQL errors[] message', async () => {
        server.use(http.post(GQL_URL, () => HttpResponse.json({ errors: [{ message: 'Rate limited' }] })));
        await expect(makeProvider({ importMax: 50 }).fetchItems()).rejects.toThrow('Hardcover GraphQL error: Rate limited');
      });

      it('a malformed later page throws with NO partial result (F38)', async () => {
        for (const badPage2 of [
          { data: { lists: [] } },
          { data: { lists: null } },
          { data: { lists: [{ id: 1, list_books: null }] } },
          listResponse([{ id: null, position: 1, book: { title: 'X' } }]),
        ]) {
          server.use(scriptedHandler([listResponse(rowsRange(0, 100)), badPage2]));
          await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toBeInstanceOf(ImportListError);
        }
      });
    });

    describe('test() probe (AC9)', () => {
      it('sends the complete { username, slug, limit: 1, offset: 0 } variable set (F33)', async () => {
        let body: GqlBody | null = null;
        server.use(http.post(GQL_URL, async ({ request }) => {
          body = await request.json() as GqlBody;
          return HttpResponse.json(listResponse(rowsRange(0, 1)));
        }));

        const result = await makeProvider({ importMax: 50 }).test();
        expect(result).toEqual({ success: true });
        expect(body!.variables).toEqual({ username: 'LisaRae', slug: '2025-year-in-books', limit: 1, offset: 0 });
      });

      it('succeeds for a resolved list, resolved-empty, and null-book-only rows', async () => {
        for (const rows of [rowsRange(0, 1), [], [row(9, null)]]) {
          server.use(http.post(GQL_URL, () => HttpResponse.json(listResponse(rows))));
          await expect(makeProvider({ importMax: 50 }).test()).resolves.toEqual({ success: true });
        }
      });

      it('lists: [] → not-found/private failure', async () => {
        server.use(http.post(GQL_URL, () => HttpResponse.json({ data: { lists: [] } })));
        const result = await makeProvider({ importMax: 50 }).test();
        expect(result).toEqual({ success: false, message: 'List not found or private' });
      });

      it('null/missing lists, list_books, or row id → unexpected-response failure', async () => {
        for (const response of [
          { data: { lists: null } },
          { data: { lists: [{ id: 1, list_books: null }] } },
          listResponse([{ id: null, position: 1, book: { title: 'X' } }]),
        ]) {
          server.use(http.post(GQL_URL, () => HttpResponse.json(response as Record<string, unknown>)));
          const result = await makeProvider({ importMax: 50 }).test();
          expect(result.success).toBe(false);
        }
      });

      it('401/403 → "Invalid API key"', async () => {
        for (const status of [401, 403]) {
          server.use(http.post(GQL_URL, () => new HttpResponse(null, { status })));
          const result = await makeProvider({ importMax: 50 }).test();
          expect(result).toEqual({ success: false, message: 'Invalid API key' });
        }
      });
    });
  });
});
