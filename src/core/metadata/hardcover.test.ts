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

    it('declares the by-id $id variable as Int! (Hardcover schema expects Int, not bigint)', async () => {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ data: { series: [] } }));
      const client = new HardcoverClient('K');
      await client.getSeriesMembersById(1170);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.query).toContain('$id: Int!');
      expect(body.query).not.toContain('bigint');
    });
  });

  // Both member queries must expose duplicate positions to the client-side picker.
  describe('members query shape — no server-side collapse (#2097 AC1)', () => {
    async function outgoingQuery(call: () => Promise<unknown>): Promise<string> {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({ data: { series: [] } }));
      await call();
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      return JSON.parse(init.body as string).query as string;
    }

    it.each([
      ['getSeriesMembers', () => new HardcoverClient('K').getSeriesMembers('The Band', 'Nicholas Eames')],
      ['getSeriesMembersById', () => new HardcoverClient('K').getSeriesMembersById(2375)],
    ])('%s no longer asks Hasura to collapse same-position rows', async (_name, call) => {
      const query = await outgoingQuery(call);
      expect(query).not.toContain('distinct_on');
    });

    it.each([
      ['getSeriesMembers', () => new HardcoverClient('K').getSeriesMembers('The Band', 'Nicholas Eames')],
      ['getSeriesMembersById', () => new HardcoverClient('K').getSeriesMembersById(2375)],
    ])('%s keeps the ordering clause and the users_count selection the picker reads', async (_name, call) => {
      const query = await outgoingQuery(call);
      expect(query).toContain('position: asc');
      expect(query).toContain('users_count: desc');
      expect(query).toContain('book { id slug title image { url } users_count }');
    });
  });

  describe('same-position duplicate works (#2097)', () => {
    const RUSSIAN_WOW = { id: 465829, slug: 'pered-burey', title: 'World of Warcraft: Перед бурей', image: null, users_count: 62 };
    const ENGLISH_WOW = { id: 331, slug: 'before-the-storm', title: 'Before the Storm', image: null, users_count: 7 };

    function seriesResponse(bookSeries: unknown[]): Response {
      return buildJsonResponse({
        data: { series: [{ id: 2375, name: 'World of Warcraft', slug: 'world-of-warcraft', author: { name: 'Christie Golden' }, book_series: bookSeries }] },
      });
    }

    it('parses a payload with two rows at one position without raising MetadataError (AC11)', async () => {
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: 15, book: RUSSIAN_WOW },
        { position: 15, book: ENGLISH_WOW },
      ]));
      await expect(new HardcoverClient('K').getSeriesMembersById(2375)).resolves.not.toBeNull();
    });

    // Live inversion: the Russian work has more readers, but Latin-script preference must win.
    it('resolves WoW position 15 to the English work end to end (AC14)', async () => {
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: 14, book: { id: 300, slug: 'illidan', title: 'Illidan', image: null, users_count: 200 } },
        { position: 15, book: RUSSIAN_WOW },
        { position: 15, book: ENGLISH_WOW },
      ]));
      const result = await new HardcoverClient('K').getSeriesMembersById(2375);
      const atFifteen = result!.members.filter((m) => m.position === 15);
      expect(atFifteen).toHaveLength(1);
      expect(atFifteen[0]!.title).toBe('Before the Storm');
      expect(atFifteen[0]!.hardcoverBookId).toBe(331);
      expect(result!.members.map((m) => m.hardcoverBookId)).toEqual([300, 331]);
    });

    it('applies the same dedup on the name+author resolve path (AC1)', async () => {
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: 15, book: RUSSIAN_WOW },
        { position: 15, book: ENGLISH_WOW },
      ]));
      const result = await new HardcoverClient('K').getSeriesMembers('World of Warcraft', 'Christie Golden');
      expect(result!.members.map((m) => m.hardcoverBookId)).toEqual([331]);
    });

    it('drops an over-length title before the pick, leaving the Cyrillic sibling holding the slot (AC8)', async () => {
      const overLength = 'B'.repeat(2049);
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: 5, book: { id: 500, slug: 'long-en', title: overLength, image: null, users_count: 900 } },
        { position: 5, book: { id: 501, slug: 'ru', title: 'Перед бурей', image: null, users_count: 3 } },
      ]));
      const result = await new HardcoverClient('K').getSeriesMembersById(2375);
      expect(result!.members).toHaveLength(1);
      expect(result!.members[0]!.hardcoverBookId).toBe(501);
      expect(result!.members[0]!.title).toBe('Перед бурей');
    });

    it('drops an over-length Cyrillic title before the pick, leaving the English sibling (AC8 mirror)', async () => {
      const overLength = `Перед бурей ${'б'.repeat(2049)}`;
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: 5, book: { id: 502, slug: 'long-ru', title: overLength, image: null, users_count: 900 } },
        { position: 5, book: { id: 503, slug: 'en', title: 'Before the Storm', image: null, users_count: 3 } },
      ]));
      const result = await new HardcoverClient('K').getSeriesMembersById(2375);
      expect(result!.members).toHaveLength(1);
      expect(result!.members[0]!.hardcoverBookId).toBe(503);
    });

    it('returns every unpositioned work instead of collapsing them to one (AC3)', async () => {
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: null, book: { id: 601, slug: 'a', title: 'Companion A', image: null, users_count: 5 } },
        { position: null, book: { id: 602, slug: 'b', title: 'Companion B', image: null, users_count: 4 } },
        { position: null, book: { id: 603, slug: 'c', title: 'Companion C', image: null, users_count: 3 } },
      ]));
      const result = await new HardcoverClient('K').getSeriesMembersById(2375);
      expect(result!.members.map((m) => m.hardcoverBookId)).toEqual([601, 602, 603]);
      expect(result!.members.map((m) => m.position)).toEqual([null, null, null]);
    });

    it('leaves an all-distinct-position series byte-identical (AC9)', async () => {
      fetchMock.mockResolvedValueOnce(seriesResponse([
        { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: { url: 'https://img/1' }, users_count: 100 } },
        { position: 2, book: { id: 1002, slug: 'bloody', title: 'Bloody Rose', image: null, users_count: 80 } },
        { position: 3, book: { id: 1003, slug: 'heretic', title: 'Heretic', image: null, users_count: 60 } },
      ]));
      const result = await new HardcoverClient('K').getSeriesMembersById(2375);
      expect(result!.members).toEqual([
        { hardcoverBookId: 1001, slug: 'kings', title: 'Kings of the Wyld', position: 1, imageUrl: 'https://img/1' },
        { hardcoverBookId: 1002, slug: 'bloody', title: 'Bloody Rose', position: 2, imageUrl: null },
        { hardcoverBookId: 1003, slug: 'heretic', title: 'Heretic', position: 3, imageUrl: null },
      ]);
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

  // Drop overlong UGC at the member-array chokepoint: truncation can create a false
  // title identity, while schema rejection would discard otherwise safe siblings.
  describe('over-length member titles (#2109 AC7)', () => {
    const MAX_VARIANT_TITLE_LENGTH = 2048;

    function memberEntry(id: number, title: string, position: number): unknown {
      return { position, book: { id, slug: `book-${id}`, title, image: { url: `https://img/${id}` }, users_count: 1 } };
    }

    async function membersFrom(entries: unknown[]): Promise<{ title: string; hardcoverBookId: number }[]> {
      fetchMock.mockResolvedValueOnce(buildJsonResponse({
        data: { series: [{ id: 1, name: 'A', slug: 'a', author: { name: 'X' }, book_series: entries }] },
      }));
      const result = await new HardcoverClient('K').getSeriesMembers('A', 'X');
      return result!.members;
    }

    const NORMAL = 'Book One';
    const AT_CAP = 'A'.repeat(MAX_VARIANT_TITLE_LENGTH);
    const OVER_CAP = 'B'.repeat(MAX_VARIANT_TITLE_LENGTH + 1);
    const ABSURD = 'C'.repeat(64_000);

    it('drops the over-length member and returns every other one (T13)', async () => {
      const members = await membersFrom([
        memberEntry(101, NORMAL, 1),
        memberEntry(102, OVER_CAP, 2),
        memberEntry(103, ABSURD, 3),
      ]);

      expect(members.map((m) => m.hardcoverBookId)).toEqual([101]);
      expect(members[0]!.title).toBe(NORMAL);
      expect(members.some((m) => m.hardcoverBookId === 102 || m.hardcoverBookId === 103)).toBe(false);
      for (const member of members) {
        expect(member.title.length).toBeLessThanOrEqual(MAX_VARIANT_TITLE_LENGTH);
        expect(OVER_CAP.startsWith(member.title)).toBe(false);
        expect(ABSURD.startsWith(member.title)).toBe(false);
      }
    });

    // Exact-cap coverage catches an accidental >= predicate.
    it('retains an exactly-at-cap member byte for byte and drops cap+1 (T13, F6)', async () => {
      const members = await membersFrom([
        memberEntry(201, AT_CAP, 1),
        memberEntry(202, OVER_CAP, 2),
      ]);

      expect(members).toHaveLength(1);
      expect(members[0]!.hardcoverBookId).toBe(201);
      expect(members[0]!.title).toBe(AT_CAP);
      expect(members[0]!.title.length).toBe(MAX_VARIANT_TITLE_LENGTH);
    });

    it('resolves the series with members: [] when every member is over the cap', async () => {
      const members = await membersFrom([memberEntry(301, OVER_CAP, 1), memberEntry(302, ABSURD, 2)]);
      expect(members).toEqual([]);
    });
  });

  describe('searchSeries — Typesense / Algolia hit extraction', () => {
    function buildSearchResponse(results: unknown): Response {
      return buildJsonResponse({ data: { search: { results } } });
    }

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
        { id: 3384, name: 'Star Wars: Aftermath', slug: 'star-wars-aftermath', authorName: 'Chuck Wendig', booksCount: 10, readersCount: 0, imageUrl: null },
      ]);
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
        { id: 5523, name: 'The Band', slug: 'the-band', authorName: 'Nicholas Eames', booksCount: 3, readersCount: 0, imageUrl: null },
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
      fetchMock.mockResolvedValueOnce(buildSearchResponse({ hits: [{ document: { id: '1', name: 'H', slug: 'h', books_count: 1 } }] }));
      const fromHits = await new HardcoverClient('K').searchSeries('h');
      expect(fromHits[0]!.id).toBe(1);

      fetchMock.mockResolvedValueOnce(buildSearchResponse({ results: [{ document: { id: '2', name: 'R', slug: 'r', books_count: 1 } }] }));
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
        { id: 51, name: 'Keeper', slug: 'keeper', authorName: null, booksCount: 1, readersCount: 0, imageUrl: null },
      ]);
    });

    it('extracts a cover image from a string `image_url` or nested `image`/`cached_image`', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        { document: { id: '1', name: 'Direct', slug: 'direct', books_count: 1, image_url: 'https://img.test/a.jpg' } },
        { document: { id: '2', name: 'Nested', slug: 'nested', books_count: 1, image: { url: 'https://img.test/b.jpg' } } },
        { document: { id: '3', name: 'Cached', slug: 'cached', books_count: 1, cached_image: { url: 'https://img.test/c.jpg' } } },
        { document: { id: '4', name: 'None', slug: 'none', books_count: 1 } },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('images');
      expect(candidates.map((c) => c.imageUrl)).toEqual([
        'https://img.test/a.jpg',
        'https://img.test/b.jpg',
        'https://img.test/c.jpg',
        null,
      ]);
    });

    it('returns [] for an empty results array', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([]));
      expect(await new HardcoverClient('K').searchSeries('nothing')).toEqual([]);
    });

    it('re-ranks by readers_count desc and drops books_count:0 stubs (#1239)', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([
        { document: { id: '1', name: 'Spinoff Graphic Novels', slug: 's1', books_count: 26, readers_count: 323 } },
        { document: { id: '2', name: 'Down Town', slug: 's2', books_count: 7, readers_count: 24 } },
        { document: { id: '3', name: 'Empty Stub', slug: 's3', books_count: 0, readers_count: 9999 } },
        { document: { id: '4', name: 'The Dresden Codex', slug: 's4', books_count: 3, readers_count: 26 } },
        { document: { id: '5', name: 'The Dresden Files', slug: 's5', books_count: 76, readers_count: 19966 } },
      ]));
      const candidates = await new HardcoverClient('K').searchSeries('dresden');
      expect(candidates.map((c) => c.name)).toEqual([
        'The Dresden Files',
        'Spinoff Graphic Novels',
        'The Dresden Codex',
        'Down Town',
      ]);
      expect(candidates.map((c) => c.readersCount)).toEqual([19966, 323, 26, 24]);
      expect(candidates.find((c) => c.name === 'Empty Stub')).toBeUndefined();
    });

    it('requests per_page: 25 so the flagship is in the candidate pool (#1239)', async () => {
      fetchMock.mockResolvedValueOnce(buildSearchResponse([]));
      await new HardcoverClient('K').searchSeries('dresden');
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.query).toContain('per_page: 25');
    });

    it('does not cap to 10 — returns the full filtered/sorted pool (resolver consumes it)', async () => {
      const hits = Array.from({ length: 12 }, (_, i) => ({
        document: { id: String(i + 1), name: `Series ${i + 1}`, slug: `s${i + 1}`, books_count: 2, readers_count: i },
      }));
      fetchMock.mockResolvedValueOnce(buildSearchResponse(hits));
      const candidates = await new HardcoverClient('K').searchSeries('many');
      expect(candidates).toHaveLength(12);
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
