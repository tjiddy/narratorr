import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { HardcoverProvider, type HardcoverConfig } from './hardcover-provider.js';
import { ImportListError } from './errors.js';
import {
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_TOTAL_RATE_LIMIT_WAIT_MS,
  RATE_LIMIT_MAX_ATTEMPTS,
} from '../utils/hardcover-http.js';

const GQL_URL = 'https://api.hardcover.app/v1/graphql';

type GqlBody = { query: string; variables?: Record<string, unknown> };

const isTrendingIdsQuery = (query: string): boolean => query.includes('books_trending');
const isBooksByIdsQuery = (query: string): boolean => query.includes('books(where');

// Route the two trending GraphQL legs by operation text.
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
        asin: 'B08G9XR74C',
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
        books: [
          { id: 30, title: 'Third', contributions: [] },
          { id: 10, title: 'First', contributions: [] },
        ],
      }));

      const provider = new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });
      const items = await provider.fetchItems();

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

    // Omission separately pins .nullish(); the preceding case covers explicit null.
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
      expect(items[0]!.isbn).toBe('0593135202');
    });

    it('yields undefined asin/isbn (not null, not a crash) when no editions exist (AC5)', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2],
        books: [
          { id: 1, title: 'No Editions', contributions: [] },
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

  // A default_audio_edition ASIN can be a real Audible edition that Audnexus does not serve, so the
  // mapper carries the payload's other Audible ASINs for the resolver to fall through to (#2611).
  describe('mapBook — alternate ASIN candidates (#2611)', () => {
    const trendingOne = async (book: Record<string, unknown>) => {
      server.use(trendingTwoStep({ ids: [1], books: [{ id: 1, contributions: [], ...book }] }));
      const items = await new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' }).fetchItems();
      return items[0]!;
    };

    it('carries the sibling editions[] ASIN as an alternate, without repeating the primary', async () => {
      // Hardcover book 1464466: the default audio edition is real but dead at Audnexus; its sibling resolves.
      const item = await trendingOne({
        title: 'This Inevitable Ruin',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: [{ asin: 'B0DK29VYL1' }, { asin: 'B0DK282SYV' }],
      });

      expect(item.asin).toBe('B0DK29VYL1');
      expect(item.alternateAsins).toEqual(['B0DK282SYV']);
    });

    it('omits the key entirely when there are no alternates', async () => {
      const item = await trendingOne({
        title: 'Single Edition',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: [{ asin: 'B0DK29VYL1' }],
      });

      // `toEqual`/`objectContaining` cannot separate an absent key from a present-`undefined` one.
      expect(item).not.toHaveProperty('alternateAsins');
    });

    it('admits only Audible-shaped candidates — a print ASIN or ISBN-10 is a wasted Audnexus probe', async () => {
      const item = await trendingOne({
        title: 'Mixed Editions',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: [{ asin: 'PRINT_ASIN' }, { asin: '0593135202' }, { asin: 'B0DK282SYV' }],
      });

      expect(item.alternateAsins).toEqual(['B0DK282SYV']);
    });

    it('leaves the print-ASIN primary untouched — the shape filter scopes to alternates only', async () => {
      const item = await trendingOne({ title: 'Print Only', editions: [{ asin: 'PRINT_ASIN' }] });

      expect(item.asin).toBe('PRINT_ASIN');
      expect(item).not.toHaveProperty('alternateAsins');
    });

    it('yields no alternates and no crash for null, empty, blank and missing edition ASINs', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2, 3, 4],
        books: [
          { id: 1, title: 'Null Editions', contributions: [], editions: null, default_audio_edition: null },
          { id: 2, title: 'Empty Editions', contributions: [], editions: [] },
          { id: 3, title: 'Null Asins', contributions: [], editions: [{ asin: null }, {}] },
          { id: 4, title: 'Blank Asins', contributions: [], default_audio_edition: { asin: 'B0DK29VYL1' }, editions: [{ asin: '' }, { asin: '   ' }] },
        ],
      }));

      const items = await new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' }).fetchItems();

      expect(items).toHaveLength(4);
      for (const item of items) expect(item).not.toHaveProperty('alternateAsins');
    });

    it('collapses canonical duplicates — repeated and padded lower-case twins are one alternate', async () => {
      const item = await trendingOne({
        title: 'Duplicated Editions',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: [{ asin: 'B0DK282SYV' }, { asin: 'B0DK282SYV' }, { asin: ' b0dk282syv ' }],
      });

      expect(item.alternateAsins).toEqual(['B0DK282SYV']);
    });

    it('emits a surviving candidate verbatim — padding and case are the resolver\'s to normalize', async () => {
      const item = await trendingOne({
        title: 'Padded Only',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: [{ asin: ' b0dk282syv ' }],
      });

      // Admitted because `isAudibleAsin` canonicalizes before testing, then stored exactly as sent.
      expect(item.alternateAsins).toEqual([' b0dk282syv ']);
    });

    it('emits every alternate at the cap and drops the overflow beyond it', async () => {
      const asins = ['B0ALT00001', 'B0ALT00002', 'B0ALT00003', 'B0ALT00004', 'B0ALT00005', 'B0ALT00006'];

      const atCap = await trendingOne({
        title: 'Five Alternates',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: asins.slice(0, 5).map((asin) => ({ asin })),
      });
      expect(atCap.alternateAsins).toEqual(asins.slice(0, 5));

      const overCap = await trendingOne({
        title: 'Six Alternates',
        default_audio_edition: { asin: 'B0DK29VYL1' },
        editions: asins.map((asin) => ({ asin })),
      });
      expect(overCap.alternateAsins).toEqual(asins.slice(0, 5));
    });

    const ALTERNATE_BOOK = {
      id: 1,
      title: 'This Inevitable Ruin',
      contributions: [],
      default_audio_edition: { asin: 'B0DK29VYL1' },
      editions: [{ asin: 'B0DK282SYV' }],
    };

    it('emits alternates on the shelf path, which shares mapBook', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({ data: { user_books: [{ book: ALTERNATE_BOOK }] } })));

      const items = await new HardcoverProvider({ apiKey: 'test-key', listType: 'shelf', shelfId: 3 }).fetchItems();

      expect(items[0]!.alternateAsins).toEqual(['B0DK282SYV']);
    });

    it('emits alternates on the custom-list path, which shares mapBook', async () => {
      server.use(http.post(GQL_URL, () => HttpResponse.json({
        data: { lists: [{ id: 1, name: 'L', ranked: true, books_count: 1, list_books: [{ id: 1, position: 1, book: ALTERNATE_BOOK }] }] },
      })));

      const items = await new HardcoverProvider({
        apiKey: 'test-key', listType: 'custom', listUrl: 'https://hardcover.app/@LisaRae/lists/2025-year-in-books',
      }).fetchItems();

      expect(items[0]!.alternateAsins).toEqual(['B0DK282SYV']);
    });
  });

  // Real Hardcover shapes: every contribution is role-tagged and the array is not author-first.
  describe('mapBook — author role selection', () => {
    const trending = () => new HardcoverProvider({ apiKey: 'test-key', listType: 'trending' });

    it('asks for the contribution role on the shared BookFields fragment', async () => {
      let body: GqlBody | null = null;
      server.use(trendingTwoStep({ ids: [1], books: [], onBooks: (b) => { body = b; } }));

      await trending().fetchItems();

      expect(body).not.toBeNull();
      expect(body!.query).toContain('contributions { contribution author { name } }');
    });

    it('picks the Author contribution rather than array position 0 (illustrator first)', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'This Inevitable Ruin',
          contributions: [
            { contribution: 'Illustrator', author: { name: 'Erik Wilson' } },
            { contribution: 'Author', author: { name: 'Matt Dinniman' } },
          ],
        }],
      }));

      const items = await trending().fetchItems();

      expect(items[0]!.author).toBe('Matt Dinniman');
    });

    it('picks the Author over the narrator', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Mastery',
          contributions: [
            { contribution: 'Narrator', author: { name: 'Fred  Sanders' } },
            { contribution: 'Author', author: { name: 'Robert Greene' } },
          ],
        }],
      }));

      const items = await trending().fetchItems();

      expect(items[0]!.author).toBe('Robert Greene');
    });

    it('matches the Author role case-insensitively', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Out of Nothing',
          contributions: [
            { contribution: 'Illustrations', author: { name: 'Daniel Locke' } },
            { contribution: 'author', author: { name: 'David Blandy' } },
          ],
        }],
      }));

      const items = await trending().fetchItems();

      expect(items[0]!.author).toBe('David Blandy');
    });

    it('falls back to the first contribution when no row carries an Author role', async () => {
      server.use(trendingTwoStep({
        ids: [1, 2],
        books: [
          { id: 1, title: 'Untagged', contributions: [{ author: { name: 'Andy Weir' } }] },
          {
            id: 2,
            title: 'No Author Role',
            contributions: [
              { contribution: 'Introduction', author: { name: 'Adam Rutherford' } },
              { contribution: 'Illustrations', author: { name: 'Daniel Locke' } },
            ],
          },
        ],
      }));

      const items = await trending().fetchItems();

      expect(items[0]!.author).toBe('Andy Weir');
      expect(items[1]!.author).toBe('Adam Rutherford');
    });

    it('ignores a nameless Author row rather than blanking the author', async () => {
      server.use(trendingTwoStep({
        ids: [1],
        books: [{
          id: 1,
          title: 'Nameless Author Row',
          contributions: [
            { contribution: 'Illustrator', author: { name: 'Erik Wilson' } },
            { contribution: 'Author', author: null },
          ],
        }],
      }));

      const items = await trending().fetchItems();

      expect(items[0]!.author).toBe('Erik Wilson');
    });

    it('yields undefined for a book with no contributions at all', async () => {
      server.use(trendingTwoStep({ ids: [1], books: [{ id: 1, title: 'Nobody', contributions: [] }] }));

      const items = await trending().fetchItems();

      expect(items[0]!.author).toBeUndefined();
    });
  });

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
          default_audio_edition: { asin: 'B0AUDIO' },
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
          { id: 2, title: 'B' },
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
          { id: 2, title: null, contributions: [] },
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

    // Serve offset/limit windows from a virtual list; booksCount defaults to total.
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
        expect(count).toBe(2);
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
        expect(count).toBe(51);
      });

      it('a large/corrupt books_count is still clamped at MAX_LIST_PAGES full pages (F34)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 5100, booksCount: 999999, onRequest: () => { count += 1; } }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toThrow(ImportListError);
        expect(count).toBe(51);
      });

      it('books_count-derived budget throws on the first full page beyond it (F28)', async () => {
        let count = 0;
        server.use(pagedHandler({ total: 500, booksCount: 250, onRequest: () => { count += 1; } }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toThrow(ImportListError);
        expect(count).toBe(4);
      });

      it('advances past a full page with an unmappable row; the row still consumes its id slot (F14)', async () => {
        const page1 = rowsRange(0, 100);
        page1[50] = row(50, { id: 50, title: null, contributions: [] });
        server.use(scriptedHandler([
          listResponse(page1),
          listResponse(rowsRange(100, 120)),
        ]));

        const items = await makeProvider({ importMax: 'all' }).fetchItems();
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

      // The sole unmappable row proves raw IDs enter seen before mapping; otherwise the
      // repeated page would appear to contain one new ID and evade the loop guard.
      it('an exact-repeat full page whose only unmappable row is titleless still triggers the repeated-page guard after the 2nd request (F5)', async () => {
        let count = 0;
        const page = rowsRange(0, 100);
        page[50] = row(50, { id: 50, title: null, contributions: [] });
        server.use(scriptedHandler([listResponse(page), listResponse(page)], () => { count += 1; }));
        await expect(makeProvider({ importMax: 'all' }).fetchItems()).rejects.toThrow(/repeated page/i);
        expect(count).toBe(2);
      });

      // An already-consumed unmappable ID must not block genuinely new overlapping rows.
      it('an overlapping page re-sending an already-seen titleless row does not re-emit or error (F5)', async () => {
        const page1 = rowsRange(0, 100);
        page1[50] = row(50, { id: 50, title: null, contributions: [] });
        const page2 = [page1[50], ...rowsRange(100, 199)];
        server.use(scriptedHandler([
          listResponse(page1),
          listResponse(page2),
          listResponse(rowsRange(199, 210)),
        ]));

        const items = await makeProvider({ importMax: 'all' }).fetchItems();
        expect(items.some((i) => i.title === 'Book 50')).toBe(false);
        expect(items).toHaveLength(209);
      });

      it('partially overlapping full pages are de-duplicated by raw id and continue (F19)', async () => {
        server.use(scriptedHandler([
          listResponse(rowsRange(0, 100)),
          listResponse(rowsRange(50, 150)),
          listResponse(rowsRange(150, 170)),
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
          row(2),
          { id: 3, position: 3 },
          row(4, { id: 4, title: null, contributions: [] }),
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

  describe('rate limiting and structured error bodies (#2537)', () => {
    const CUSTOM_URL = 'https://hardcover.app/@LisaRae/lists/2025-year-in-books';
    const PAGE_SIZE = 100;

    // Exact-delay assertions with real MSW responses: capture the requested backoff and
    // re-dispatch it at 0. Full fake timers would stall MSW and the native AbortSignal.timeout
    // inside fetchWithTimeout.
    function recordSleeps(): number[] {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);
      return delays;
    }

    afterEach(() => { vi.restoreAllMocks(); });

    function tooMany(opts: { retryAfter?: string; body?: string } = {}): Response {
      return new HttpResponse(opts.body ?? null, {
        status: 429,
        statusText: 'Too Many Requests',
        ...(opts.retryAfter === undefined ? {} : { headers: { 'Retry-After': opts.retryAfter } }),
      });
    }

    /** Serves the scripted responses in arrival order, repeating the last one thereafter. */
    function scripted(responses: Array<() => Response>, onRequest?: (vars: Record<string, unknown>) => void) {
      let i = 0;
      return http.post(GQL_URL, async ({ request }) => {
        const body = await request.json() as GqlBody;
        onRequest?.(body.variables ?? {});
        const next = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        return next();
      });
    }

    const shelfProvider = () => new HardcoverProvider({ apiKey: 'k', listType: 'shelf', shelfId: 3 });
    const customProvider = (overrides: Partial<HardcoverConfig> = {}) =>
      new HardcoverProvider({ apiKey: 'k', listType: 'custom', listUrl: CUSTOM_URL, ...overrides });

    const shelfBooks = () => HttpResponse.json({
      data: { user_books: [{ book: { id: 1, title: 'Shelved', contributions: [] } }] },
    });

    const listRow = (id: number) => ({ id, position: id, book: { id, title: `Book ${id}`, contributions: [] } });
    const listPage = (offset: number, count: number, booksCount: number) => HttpResponse.json({
      data: {
        lists: [{
          id: 1, name: 'L', ranked: true, books_count: booksCount,
          list_books: Array.from({ length: count }, (_, i) => listRow(offset + i)),
        }],
      },
    });

    describe('retry lives in executeQuery, so every request site gets it (AC2)', () => {
      it('retries a throttled trending ids leg once and completes the two-step flow', async () => {
        const delays = recordSleeps();
        let requests = 0;
        server.use(http.post(GQL_URL, async ({ request }) => {
          requests += 1;
          const body = await request.json() as GqlBody;
          if (requests === 1) return tooMany({ retryAfter: '1' });
          if (isTrendingIdsQuery(body.query)) return HttpResponse.json({ data: { books_trending: { ids: [7] } } });
          return HttpResponse.json({ data: { books: [{ id: 7, title: 'Seven', contributions: [] }] } });
        }));

        const items = await new HardcoverProvider({ apiKey: 'k', listType: 'trending' }).fetchItems();

        expect(items).toEqual([expect.objectContaining({ title: 'Seven' })]);
        expect(delays).toEqual([1000]);
        // Two ids attempts plus the books leg.
        expect(requests).toBe(3);
      });

      it('retries a throttled shelf query once', async () => {
        const delays = recordSleeps();
        let requests = 0;
        server.use(scripted([() => { requests += 1; return tooMany({ retryAfter: '1' }); }, () => { requests += 1; return shelfBooks(); }]));

        const items = await shelfProvider().fetchItems();

        expect(items).toEqual([expect.objectContaining({ title: 'Shelved' })]);
        expect(delays).toEqual([1000]);
        expect(requests).toBe(2);
      });

      it('retries a throttled fixed-limit custom query once', async () => {
        const delays = recordSleeps();
        server.use(scripted([() => tooMany({ retryAfter: '1' }), () => listPage(0, 2, 2)]));

        const items = await customProvider({ importMax: 50 }).fetchItems();

        expect(items).toHaveLength(2);
        expect(delays).toEqual([1000]);
      });

      it('retries the second trending leg and still restores the ids rank order', async () => {
        const delays = recordSleeps();
        let booksAttempts = 0;
        server.use(http.post(GQL_URL, async ({ request }) => {
          const body = await request.json() as GqlBody;
          if (isTrendingIdsQuery(body.query)) return HttpResponse.json({ data: { books_trending: { ids: [2, 1] } } });
          booksAttempts += 1;
          if (booksAttempts === 1) return tooMany({ retryAfter: '2' });
          return HttpResponse.json({
            data: {
              books: [
                { id: 1, title: 'First by id', contributions: [] },
                { id: 2, title: 'Second by id', contributions: [] },
              ],
            },
          });
        }));

        const items = await new HardcoverProvider({ apiKey: 'k', listType: 'trending' }).fetchItems();

        expect(items.map((i) => i.title)).toEqual(['Second by id', 'First by id']);
        expect(delays).toEqual([2000]);
        expect(booksAttempts).toBe(2);
      });
    });

    describe('per-request attempt cap and per-wait clamp (AC2)', () => {
      it('gives up after RATE_LIMIT_MAX_ATTEMPTS requests and one fewer sleeps', async () => {
        const delays = recordSleeps();
        let requests = 0;
        server.use(http.post(GQL_URL, () => { requests += 1; return tooMany({ retryAfter: '1' }); }));

        const error: unknown = await shelfProvider().fetchItems().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ImportListError);
        expect((error as ImportListError).message).toContain('429');
        expect((error as ImportListError).message).toContain('rate limited');
        expect(requests).toBe(RATE_LIMIT_MAX_ATTEMPTS);
        expect(delays).toHaveLength(RATE_LIMIT_MAX_ATTEMPTS - 1);
      });

      it('clamps an over-long Retry-After to the per-wait maximum', async () => {
        const delays = recordSleeps();
        server.use(scripted([() => tooMany({ retryAfter: '600' }), () => shelfBooks()]));

        await shelfProvider().fetchItems();

        expect(delays).toEqual([MAX_RATE_LIMIT_WAIT_MS]);
      });

      it('clamps the 60s default when Retry-After is absent', async () => {
        const delays = recordSleeps();
        server.use(scripted([() => tooMany(), () => shelfBooks()]));

        await shelfProvider().fetchItems();

        expect(delays).toEqual([MAX_RATE_LIMIT_WAIT_MS]);
      });
    });

    describe('cumulative budget across a paginated call (AC2 × AC3)', () => {
      // Each 30s wait is the clamped maximum, so four of them spend the whole call budget.
      const WAIT_HEADER = '30';

      /** Two full pages that each need two retries, then the caller-supplied tail. */
      function twoThrottledPagesThen(tail: () => Response) {
        return scripted([
          () => tooMany({ retryAfter: WAIT_HEADER }),
          () => tooMany({ retryAfter: WAIT_HEADER }),
          () => listPage(0, PAGE_SIZE, 1000),
          () => tooMany({ retryAfter: WAIT_HEADER }),
          () => tooMany({ retryAfter: WAIT_HEADER }),
          () => listPage(PAGE_SIZE, PAGE_SIZE, 1000),
          tail,
        ]);
      }

      it('completes when the waits total exactly the budget', async () => {
        const delays = recordSleeps();
        server.use(twoThrottledPagesThen(() => listPage(PAGE_SIZE * 2, 50, 1000)));

        const items = await customProvider({ importMax: 'all' }).fetchItems();

        expect(items).toHaveLength(250);
        expect(delays.reduce((a, b) => a + b, 0)).toBe(MAX_TOTAL_RATE_LIMIT_WAIT_MS);
      });

      it('fails with no partial result — and no extra sleep — one wait past the budget', async () => {
        const delays = recordSleeps();
        server.use(twoThrottledPagesThen(() => tooMany({ retryAfter: WAIT_HEADER })));

        const result: unknown = await customProvider({ importMax: 'all' }).fetchItems()
          .then((items) => ({ leaked: items }), (error: unknown) => error);

        expect(result).toBeInstanceOf(ImportListError);
        expect((result as ImportListError).message).toContain('rate limited');
        // The over-budget wait is refused outright, not slept-then-failed.
        expect(delays).toHaveLength(4);
        expect(delays.reduce((a, b) => a + b, 0)).toBe(MAX_TOTAL_RATE_LIMIT_WAIT_MS);
      });
    });

    describe('the budget is call-local, not instance state (AC2)', () => {
      it('gives a second sequential fetchItems() on the same instance a full budget', async () => {
        const delays = recordSleeps();
        // One call's worth of script, twice: each spends the full 4 × 30s allowance.
        const oneCall: Array<() => Response> = [
          () => tooMany({ retryAfter: '30' }),
          () => tooMany({ retryAfter: '30' }),
          () => listPage(0, PAGE_SIZE, 200),
          () => tooMany({ retryAfter: '30' }),
          () => tooMany({ retryAfter: '30' }),
          () => listPage(PAGE_SIZE, 20, 200),
        ];
        server.use(scripted([...oneCall, ...oneCall]));

        const provider = customProvider({ importMax: 'all' });
        await expect(provider.fetchItems()).resolves.toHaveLength(120);
        await expect(provider.fetchItems()).resolves.toHaveLength(120);

        expect(delays).toHaveLength(8);
        expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(MAX_TOTAL_RATE_LIMIT_WAIT_MS);
      });

      it('gives two concurrent fetchItems() on the same instance independent budgets', async () => {
        const delays = recordSleeps();
        // Both calls walk the same two offsets, so each offset sees two attempts per call before
        // succeeding. The fixture is symmetric: each call spends exactly half the recorded waits.
        const throttledPerOffset = new Map<number, number>();
        server.use(http.post(GQL_URL, async ({ request }) => {
          const body = await request.json() as GqlBody;
          const offset = Number(body.variables?.offset ?? 0);
          const seen = throttledPerOffset.get(offset) ?? 0;
          if (seen < 4) {
            throttledPerOffset.set(offset, seen + 1);
            return tooMany({ retryAfter: '20' });
          }
          return offset === 0 ? listPage(0, PAGE_SIZE, 200) : listPage(PAGE_SIZE, 20, 200);
        }));

        const provider = customProvider({ importMax: 'all' });
        const [first, second] = await Promise.all([provider.fetchItems(), provider.fetchItems()]);

        expect(first).toHaveLength(120);
        expect(second).toHaveLength(120);
        expect(delays).toEqual(Array.from({ length: 8 }, () => 20_000));
        const spendPerCall = delays.reduce((a, b) => a + b, 0) / 2;
        expect(spendPerCall).toBeLessThanOrEqual(MAX_TOTAL_RATE_LIMIT_WAIT_MS);
        // Only independent budgets can fund more total waiting than one budget allows.
        expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(MAX_TOTAL_RATE_LIMIT_WAIT_MS);
      });
    });

    describe('what is NOT retried (AC2)', () => {
      it.each([401, 403, 500])('issues exactly one request for HTTP %i', async (status) => {
        const delays = recordSleeps();
        let requests = 0;
        server.use(http.post(GQL_URL, () => {
          requests += 1;
          return new HttpResponse(null, { status, statusText: 'Nope' });
        }));

        await expect(shelfProvider().fetchItems()).rejects.toBeInstanceOf(ImportListError);

        expect(requests).toBe(1);
        expect(delays).toHaveLength(0);
      });

      it('refuses to wait out a structural top_level_limit_exceeded 429', async () => {
        const delays = recordSleeps();
        let requests = 0;
        server.use(http.post(GQL_URL, () => {
          requests += 1;
          return tooMany({ retryAfter: '1', body: '{"error":"top_level_limit_exceeded"}' });
        }));

        const error: unknown = await shelfProvider().fetchItems().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ImportListError);
        expect((error as ImportListError).message).toContain('top_level_limit_exceeded');
        expect((error as ImportListError).message).not.toContain('rate limited');
        expect(requests).toBe(1);
        expect(delays).toHaveLength(0);
      });
    });

    describe('interaction with the existing pagination guards (AC2 × AC3)', () => {
      it('does not let a retried page count against the repeated-page or full-page guards', async () => {
        recordSleeps();
        // books_count 200 funds exactly two full pages; the retry must not consume a third slot.
        server.use(scripted([
          () => listPage(0, PAGE_SIZE, 200),
          () => tooMany({ retryAfter: '1' }),
          () => listPage(PAGE_SIZE, PAGE_SIZE, 200),
          () => listPage(PAGE_SIZE * 2, 50, 200),
        ]));

        const items = await customProvider({ importMax: 'all' }).fetchItems();

        expect(items).toHaveLength(250);
      });

      it('still reports the runaway guard, not rate limiting, when the page budget is what overruns', async () => {
        recordSleeps();
        // books_count 100 funds one full page; every page comes back full. The single 429 is
        // retried successfully, so the guard that actually trips is the page budget.
        let throttledSecondPage = false;
        server.use(http.post(GQL_URL, async ({ request }) => {
          const body = await request.json() as GqlBody;
          const offset = Number(body.variables?.offset ?? 0);
          if (offset === PAGE_SIZE && !throttledSecondPage) {
            throttledSecondPage = true;
            return tooMany({ retryAfter: '1' });
          }
          return listPage(offset, PAGE_SIZE, 100);
        }));

        const error: unknown = await customProvider({ importMax: 'all' }).fetchItems().catch((e: unknown) => e);

        expect((error as ImportListError).message).toMatch(/pagination runaway/);
        expect((error as ImportListError).message).not.toContain('rate limited');
      });
    });

    describe('structured error bodies through executeQuery (AC4)', () => {
      const PROVIDER_BASELINE = 'Hardcover API returned 500: Internal Server Error';

      async function syncError(body: BodyInit | null, init: ResponseInit): Promise<ImportListError> {
        server.use(http.post(GQL_URL, () => new HttpResponse(body, init)));
        const error: unknown = await shelfProvider().fetchItems().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ImportListError);
        return error as ImportListError;
      }

      it('surfaces an insufficient_scope 403 with its code and scope', async () => {
        const error = await syncError(
          JSON.stringify({ error: 'insufficient_scope', error_description: 'Token lacks a scope', scope: 'read:series' }),
          { status: 403, statusText: 'Forbidden' },
        );

        expect(error.message).toContain('403');
        expect(error.message).toContain('insufficient_scope');
        expect(error.message).toContain('read:series');
      });

      it('surfaces an invalid_token 401 with its code', async () => {
        const error = await syncError('{"error":"invalid_token"}', { status: 401, statusText: 'Unauthorized' });

        expect(error.message).toContain('401');
        expect(error.message).toContain('invalid_token');
      });

      it('names insufficient_scope with no scope field and prints no undefined/null placeholder', async () => {
        const error = await syncError('{"error":"insufficient_scope"}', { status: 403, statusText: 'Forbidden' });

        expect(error.message).toContain('insufficient_scope');
        expect(error.message).not.toMatch(/undefined|null/);
      });

      it('caps an over-long field value rather than echoing the whole body', async () => {
        const error = await syncError(
          JSON.stringify({ error_description: 'y'.repeat(5000) }),
          { status: 400, statusText: 'Bad Request' },
        );

        expect(error.message.length).toBeLessThan(400);
        expect(error.message).toContain('400');
      });

      it('does not leak an HTML outage page into lastSyncError', async () => {
        const error = await syncError(
          '<!DOCTYPE html><html><body>Hardcover is down</body></html>',
          { status: 500, statusText: 'Internal Server Error' },
        );

        expect(error.message).toBe(PROVIDER_BASELINE);
        expect(error.message).not.toContain('<html');
        expect(error.message).not.toContain('<!DOCTYPE');
      });

      it.each([
        ['undocumented keys', '{"foo":"bar"}'],
        ['an empty body', ''],
        ['an empty object', '{}'],
        ['a JSON array', '[]'],
        ['a JSON string primitive', '"nope"'],
        ['a JSON number primitive', '42'],
      ])('%s keeps the pre-change provider baseline', async (_label, body) => {
        expect((await syncError(body, { status: 500, statusText: 'Internal Server Error' })).message)
          .toBe(PROVIDER_BASELINE);
      });

      it('drops every documented key whose value is not a string', async () => {
        const error = await syncError(
          JSON.stringify({ error: { a: 1 }, error_description: ['x'], scope: 42, message: null }),
          { status: 500, statusText: 'Internal Server Error' },
        );

        expect(error.message).toBe(PROVIDER_BASELINE);
        expect(error.message).not.toContain('[object Object]');
        expect(error.message).not.toContain('{"a":1}');
        expect(error.message).not.toContain('"x"');
        expect(error.message).not.toContain('42');
      });

      it('leaves a 200 GraphQL envelope on its existing path — the body descriptor never sees it', async () => {
        server.use(http.post(GQL_URL, () => HttpResponse.json({ errors: [{ message: 'top_level_limit_exceeded' }] })));

        const error: unknown = await shelfProvider().fetchItems().catch((e: unknown) => e);

        expect((error as ImportListError).message).toBe('Hardcover GraphQL error: top_level_limit_exceeded');
      });
    });

    describe('test() probe (AC6)', () => {
      it('reports rate limiting without retrying or sleeping', async () => {
        const delays = recordSleeps();
        let requests = 0;
        server.use(http.post(GQL_URL, () => { requests += 1; return tooMany({ retryAfter: '60' }); }));

        const result = await shelfProvider().test();

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/rate-limiting/i);
        expect(result.message).toMatch(/shortly/i);
        expect(requests).toBe(1);
        expect(delays).toHaveLength(0);
      });

      it('reports a structural top_level_limit_exceeded 429 as the code, not as a throttle', async () => {
        let requests = 0;
        server.use(http.post(GQL_URL, () => {
          requests += 1;
          return tooMany({ retryAfter: '60', body: '{"error":"top_level_limit_exceeded"}' });
        }));

        const result = await shelfProvider().test();

        expect(result.message).toContain('top_level_limit_exceeded');
        expect(result.message).not.toMatch(/rate-limiting/i);
        expect(requests).toBe(1);
      });

      it('names the missing scope on an under-scoped 403 instead of a bare invalid-key message', async () => {
        server.use(http.post(GQL_URL, () => new HttpResponse(
          JSON.stringify({ error: 'insufficient_scope', scope: 'read:lists' }),
          { status: 403, statusText: 'Forbidden' },
        )));

        const result = await shelfProvider().test();

        expect(result.success).toBe(false);
        // The shared #2554 sentence must LEAD — an "Invalid API key" headline with the scope
        // buried in the suffix misdirects the operator into regenerating a key that isn't wrong.
        expect(result.message).toMatch(
          /^Your Hardcover API key is missing a required scope \(read:lists\)\. Regenerate the token with that scope enabled\./,
        );
        expect(result.message).toContain('insufficient_scope');
        expect(result.message).not.toContain('Invalid API key');
      });

      it('names invalid_token on a 401', async () => {
        server.use(http.post(GQL_URL, () => new HttpResponse(
          '{"error":"invalid_token"}',
          { status: 401, statusText: 'Unauthorized' },
        )));

        const result = await shelfProvider().test();

        expect(result.success).toBe(false);
        expect(result.message).toContain('invalid_token');
      });
    });

    describe('Bearer paste normalization (AC7)', () => {
      it('sends a single Bearer prefix for a pasted "Bearer <token>" key', async () => {
        let authorization: string | null = null;
        server.use(http.post(GQL_URL, ({ request }) => {
          authorization = request.headers.get('Authorization');
          return shelfBooks();
        }));

        await new HardcoverProvider({ apiKey: 'Bearer hc_pat_x', listType: 'shelf', shelfId: 3 }).fetchItems();

        expect(authorization).toBe('Bearer hc_pat_x');
      });

      it('still issues the request for a key that normalizes to empty, failing on the server answer', async () => {
        let requests = 0;
        server.use(http.post(GQL_URL, () => {
          requests += 1;
          return new HttpResponse('{"error":"invalid_token"}', { status: 401, statusText: 'Unauthorized' });
        }));

        const provider = new HardcoverProvider({ apiKey: 'Bearer ', listType: 'shelf', shelfId: 3 });

        await expect(provider.fetchItems()).rejects.toThrow(/401/);
        expect(requests).toBe(1);
      });
    });
  });
});
