import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { formatZodError } from './format-zod-error.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { IMPORT_LIST_TIMEOUT_MS } from '../utils/constants.js';
import { parseHardcoverListUrl } from '../../shared/hardcover-list-url.js';
import type { HardcoverListType } from '../../shared/hardcover-list-types.js';

export interface HardcoverConfig {
  apiKey: string;
  listType: HardcoverListType;
  shelfId?: number;
  listUrl?: string;
  importMax?: 50 | 100 | 'all';
}

const GRAPHQL_URL = 'https://api.hardcover.app/v1/graphql';

// #1879 — custom-list ('all') pagination bounds. `PAGE_SIZE` is the per-request
// window; `MAX_LIST_PAGES` is an absolute cap on FULL data pages (≤ 5000 rows)
// that even a large/corrupt `books_count` cannot exceed (AC5).
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;

const NOT_FOUND_MSG = 'List not found or private';
const UNEXPECTED_LISTS_MSG = 'Hardcover returned an unexpected response (missing lists)';
const UNEXPECTED_ROWS_MSG = 'Hardcover returned an unexpected response (missing list_books)';
const UNEXPECTED_ROW_ID_MSG = 'Hardcover returned an unexpected response (list row without a numeric id)';
const REPEATED_PAGE_MSG = 'Hardcover returned a repeated page (offset appears to be ignored)';
const RUNAWAY_MSG = 'Hardcover list exceeds the supported size (pagination runaway guard)';
const BAD_URL_MSG = 'Not a Hardcover list URL';

// Trending window: `books_trending` ranks books over a [from, to] date range.
// `from = today − TRENDING_WINDOW_DAYS`, `to = today`. No settings field — these
// are module constants by design (see #1617 AC2).
const TRENDING_WINDOW_DAYS = 7;
const TRENDING_LIMIT = 50;
const SHELF_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// Shared book→ImportListItem projection. Both trending (`books`) and shelf
// (`user_books[].book`) resolve to the GraphQL `books` type, so a single
// fragment + single `mapBook` keeps the two paths from drifting apart (#1617 AC6).
const BOOK_FRAGMENT = `
  fragment BookFields on books {
    id
    title
    subtitle
    description
    image { url }
    contributions { author { name } }
    default_audio_edition { asin isbn_13 isbn_10 image { url } }
    editions { asin isbn_13 isbn_10 }
  }
`;

// Trending is a two-step fetch: `books_trending` returns only ranked `ids`,
// then `books(where: { id: { _in } })` resolves those ids to book objects.
const TRENDING_IDS_QUERY = `
  query Trending($from: date!, $to: date!, $limit: Int!, $offset: Int!) {
    books_trending(from: $from, to: $to, limit: $limit, offset: $offset) {
      ids
    }
  }
`;

const BOOKS_BY_IDS_QUERY = `
  query BooksByIds($ids: [Int!]) {
    books(where: { id: { _in: $ids } }) {
      ...BookFields
    }
  }
  ${BOOK_FRAGMENT}
`;

const SHELF_QUERY = `
  query Shelf($statusId: Int!, $limit: Int!) {
    user_books(where: { status_id: { _eq: $statusId } }, limit: $limit) {
      book {
        ...BookFields
      }
    }
  }
  ${BOOK_FRAGMENT}
`;

// #1879 — resolve one public list by `@username` + slug, then page its ordered
// rows. `public: { _eq: true }` gates a private list out at the query level (an
// unresolved list comes back as `lists: []`). Multi-column ordering MUST use the
// array-of-single-key-objects form — Hasura's `order_by` is a list and does not
// preserve key order inside one input object (matches src/core/metadata/hardcover.ts).
const CUSTOM_LIST_QUERY = `
  query CustomList($username: citext!, $slug: String!, $limit: Int!, $offset: Int!) {
    lists(
      where: {
        slug: { _eq: $slug },
        user: { username: { _eq: $username } },
        public: { _eq: true }
      },
      limit: 1
    ) {
      id
      name
      ranked
      books_count
      list_books(order_by: [{ position: asc_nulls_last }, { id: asc }], limit: $limit, offset: $offset) {
        id
        position
        book {
          ...BookFields
        }
      }
    }
  }
  ${BOOK_FRAGMENT}
`;

const editionSchema = z.object({
  asin: z.string().nullish(),
  isbn_13: z.string().nullish(),
  isbn_10: z.string().nullish(),
  // External-API field — must accept null, not just undefined (zod-nullish-external-api).
  // Only `default_audio_edition` requests this in the query; print `editions` omit it.
  image: z.object({ url: z.string().nullish() }).passthrough().nullish(),
}).passthrough();

const hardcoverBookSchema = z.object({
  id: z.number().nullish(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  description: z.string().nullish(),
  image: z.object({ url: z.string().nullish() }).passthrough().nullish(),
  contributions: z.array(z.object({
    author: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  }).passthrough()).nullish(),
  default_audio_edition: editionSchema.nullish(),
  editions: z.array(editionSchema).nullish(),
}).passthrough();

type HardcoverBook = z.infer<typeof hardcoverBookSchema>;
type HardcoverEdition = z.infer<typeof editionSchema>;

// #1879 — custom list rows. Every externally-parsed field is `.nullish()`
// (zod-nullish-external-api); the algorithm's post-parse dispositions (AC8) are
// what guard the fields it depends on (`id` must be numeric; `list_books` must
// be a real array, not null/missing).
const hardcoverListBookSchema = z.object({
  id: z.number().nullish(),
  position: z.number().nullish(),
  book: hardcoverBookSchema.nullish(),
}).passthrough();

const hardcoverListSchema = z.object({
  id: z.number().nullish(),
  name: z.string().nullish(),
  ranked: z.boolean().nullish(),
  books_count: z.number().nullish(),
  list_books: z.array(hardcoverListBookSchema).nullish(),
}).passthrough();

type HardcoverList = z.infer<typeof hardcoverListSchema>;
type HardcoverListBook = z.infer<typeof hardcoverListBookSchema>;

const hardcoverResponseSchema = z.object({
  data: z.object({
    books_trending: z.object({ ids: z.array(z.number()).nullish() }).passthrough().nullish(),
    books: z.array(hardcoverBookSchema).nullish(),
    user_books: z.array(z.object({ book: hardcoverBookSchema.nullish() }).passthrough()).nullish(),
    lists: z.array(hardcoverListSchema).nullish(),
  }).passthrough().nullish(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).nullish(),
}).passthrough();

type HardcoverResponse = z.infer<typeof hardcoverResponseSchema>;

// Freeze the FULL-page budget from the first response's `books_count`: the ceil
// of pages the count implies, clamped to the absolute MAX_LIST_PAGES cap. A
// missing/null/non-positive/non-finite count falls back to the cap (AC5).
function customPageBudget(booksCount: number | null | undefined): number {
  const base = (typeof booksCount === 'number' && Number.isFinite(booksCount) && booksCount > 0)
    ? Math.ceil(booksCount / PAGE_SIZE)
    : MAX_LIST_PAGES;
  return Math.min(MAX_LIST_PAGES, base);
}

function editionAsin(edition: HardcoverEdition | null | undefined): string | undefined {
  return edition?.asin || undefined;
}

function editionIsbn(edition: HardcoverEdition | null | undefined): string | undefined {
  return edition?.isbn_13 || edition?.isbn_10 || undefined;
}

// ASIN/ISBN prefer the audiobook edition (narratorr matches on Audible ASINs),
// then fall back to the first print edition carrying the identifier (#1617 AC5).
function pickAsin(book: HardcoverBook): string | undefined {
  return editionAsin(book.default_audio_edition)
    ?? (book.editions ?? []).map(editionAsin).find((v) => v !== undefined);
}

function pickIsbn(book: HardcoverBook): string | undefined {
  return editionIsbn(book.default_audio_edition)
    ?? (book.editions ?? []).map(editionIsbn).find((v) => v !== undefined);
}

function mapBook(book: HardcoverBook): ImportListItem | null {
  if (!book.title) return null;
  return {
    title: book.title,
    author: book.contributions?.[0]?.author?.name || undefined,
    asin: pickAsin(book),
    isbn: pickIsbn(book),
    // Prefer the audiobook edition's cover over the book's default (print) image
    // so the at-add cover is the audiobook one when Hardcover exposes it (#1634
    // Layer 1). Falls back to the print image when the audio edition or its image
    // is absent/empty. Layer 2 (Audnexus override at enrichment) is the guarantor.
    coverUrl: book.default_audio_edition?.image?.url || book.image?.url || undefined,
    description: book.description || undefined,
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function trendingWindow(): { from: string; to: string } {
  const now = new Date();
  return {
    from: isoDate(new Date(now.getTime() - TRENDING_WINDOW_DAYS * DAY_MS)),
    to: isoDate(now),
  };
}

export class HardcoverProvider implements ImportListProvider {
  readonly type = 'hardcover';
  readonly name = 'Hardcover';

  private apiKey: string;
  private listType: HardcoverListType;
  private shelfId?: number;
  private listUrl?: string;
  private importMax?: 50 | 100 | 'all';

  constructor(config: HardcoverConfig) {
    this.apiKey = config.apiKey;
    this.listType = config.listType;
    if (config.shelfId !== undefined) this.shelfId = config.shelfId;
    if (config.listUrl !== undefined) this.listUrl = config.listUrl;
    if (config.importMax !== undefined) this.importMax = config.importMax;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    if (this.listType === 'custom') return this.fetchCustomList();
    return this.listType === 'shelf' ? this.fetchShelf() : this.fetchTrending();
  }

  private async fetchCustomList(): Promise<ImportListItem[]> {
    const { username, slug } = this.requireParsedUrl();
    const importMax = this.importMax ?? 50;
    if (importMax === 'all') return this.fetchAllPages(username, slug);

    // Fixed limit — a single query for the first N rows by list position.
    const data = await this.executeQuery(CUSTOM_LIST_QUERY, { username, slug, limit: importMax, offset: 0 });
    const rows = this.resolveRows(data);
    this.validateRowIds(rows);
    return this.emitRows(rows, new Set<number>());
  }

  // `all` — bounded pagination over `list_books` keyed on the RAW `list_books.id`.
  // Validity + de-dup happen on raw rows BEFORE (and independent of) book mapping,
  // so a row `mapBook` drops still consumes its id slot (AC5/AC6).
  private async fetchAllPages(username: string, slug: string): Promise<ImportListItem[]> {
    const seen = new Set<number>();
    const items: ImportListItem[] = [];
    let offset = 0;
    let fullPageBudget = MAX_LIST_PAGES;
    let budgetFrozen = false;
    let fullPagesFetched = 0;

    for (;;) {
      const data = await this.executeQuery(CUSTOM_LIST_QUERY, { username, slug, limit: PAGE_SIZE, offset });
      const list = this.resolveList(data);
      const rows = this.requireRows(list);
      this.validateRowIds(rows);

      if (!budgetFrozen) {
        // Freeze the budget from the FIRST response only — `books_count` cannot
        // change the bound mid-run (F17).
        fullPageBudget = customPageBudget(list.books_count);
        budgetFrozen = true;
      }

      const isFullPage = rows.length === PAGE_SIZE;
      const newRows = rows.filter((row) => !seen.has(row.id as number));
      // A FULL page contributing zero new ids means the server ignored `offset`.
      if (isFullPage && newRows.length === 0) throw new ImportListError(this.name, REPEATED_PAGE_MSG);

      items.push(...this.emitRows(newRows, seen));

      // Terminal short/empty page is ALWAYS permitted — the budget bounds only FULL pages.
      if (!isFullPage) return items;

      fullPagesFetched += 1;
      if (fullPagesFetched > fullPageBudget) throw new ImportListError(this.name, RUNAWAY_MSG);
      offset += PAGE_SIZE;
    }
  }

  private requireParsedUrl(): { username: string; slug: string } {
    const parsed = parseHardcoverListUrl(this.listUrl ?? '');
    if (!parsed) throw new ImportListError(this.name, BAD_URL_MSG);
    return parsed;
  }

  // `lists: []` → not-found/private (AC7); `lists` null/missing → malformed (AC8).
  private resolveList(data: HardcoverResponse): HardcoverList {
    const lists = data.data?.lists;
    if (lists == null) throw new ImportListError(this.name, UNEXPECTED_LISTS_MSG);
    if (lists.length === 0) throw new ImportListError(this.name, NOT_FOUND_MSG);
    return lists[0]!;
  }

  // A resolved list's `list_books: []` is a genuine empty list (success); null/
  // missing is a malformed nested response (AC8), distinct from a real empty array.
  private requireRows(list: HardcoverList): HardcoverListBook[] {
    const rows = list.list_books;
    if (rows == null) throw new ImportListError(this.name, UNEXPECTED_ROWS_MSG);
    return rows;
  }

  private resolveRows(data: HardcoverResponse): HardcoverListBook[] {
    return this.requireRows(this.resolveList(data));
  }

  // Every row needs a numeric id — it is the stable dedup/loop-guard key (AC8).
  private validateRowIds(rows: HardcoverListBook[]): void {
    for (const row of rows) {
      if (typeof row.id !== 'number') throw new ImportListError(this.name, UNEXPECTED_ROW_ID_MSG);
    }
  }

  // Emit output for unseen rows in query order; a row whose `book` is null/missing/
  // unmappable still consumes its id slot (added to `seen`) but is dropped from output.
  private emitRows(rows: HardcoverListBook[], seen: Set<number>): ImportListItem[] {
    const out: ImportListItem[] = [];
    for (const row of rows) {
      const id = row.id as number;
      if (seen.has(id)) continue;
      seen.add(id);
      const item = row.book != null ? mapBook(row.book) : null;
      if (item) out.push(item);
    }
    return out;
  }

  private async fetchTrending(): Promise<ImportListItem[]> {
    const { from, to } = trendingWindow();
    const idsData = await this.executeQuery(TRENDING_IDS_QUERY, {
      from, to, limit: TRENDING_LIMIT, offset: 0,
    });

    const ids = idsData.data?.books_trending?.ids ?? [];
    // Empty/null ids → skip the second query entirely (#1617 AC3).
    if (ids.length === 0) return [];

    const booksData = await this.executeQuery(BOOKS_BY_IDS_QUERY, { ids });

    // `books(where:{id:{_in}})` returns rows unordered; re-sort into the original
    // trending-rank order from `books_trending.ids`, dropping ids with no row (#1617 AC1).
    const byId = new Map<number, ImportListItem>();
    for (const book of booksData.data?.books ?? []) {
      const item = mapBook(book);
      if (item && typeof book.id === 'number') byId.set(book.id, item);
    }
    return ids.map((id) => byId.get(id)).filter((item): item is ImportListItem => item != null);
  }

  private async fetchShelf(): Promise<ImportListItem[]> {
    const data = await this.executeQuery(SHELF_QUERY, { statusId: this.shelfId, limit: SHELF_LIMIT });
    return (data.data?.user_books ?? [])
      .map((entry) => entry.book)
      .filter((book): book is HardcoverBook => book != null)
      .map(mapBook)
      .filter((item): item is ImportListItem => item != null);
  }

  private async executeQuery(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<HardcoverResponse> {
    const res = await fetchWithTimeout(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    }, IMPORT_LIST_TIMEOUT_MS);

    if (!res.ok) {
      throw new ImportListError(this.name, `Hardcover API returned ${res.status}: ${res.statusText}`);
    }

    const raw: unknown = await res.json();
    const parsed = hardcoverResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ImportListError(
        this.name,
        `Hardcover returned unexpected response: ${formatZodError(parsed.error)}`,
        { cause: parsed.error },
      );
    }
    if (parsed.data.errors?.length) {
      throw new ImportListError(this.name, `Hardcover GraphQL error: ${parsed.data.errors[0]!.message}`);
    }
    return parsed.data;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const { query, variables } = this.buildProbe();
      const res = await fetchWithTimeout(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
      }, IMPORT_LIST_TIMEOUT_MS);

      if (res.status === 401 || res.status === 403) {
        return { success: false, message: 'Invalid API key' };
      }

      if (!res.ok) {
        return { success: false, message: `API returned ${res.status}: ${res.statusText}` };
      }

      const raw: unknown = await res.json();
      const parsed = hardcoverResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return { success: false, message: `Validation failed: ${formatZodError(parsed.error)}` };
      }
      // A real query surfaces schema drift (a missing field lands in `errors[]`)
      // that the old `{ __typename }` probe could never catch (#1617 AC8).
      if (parsed.data.errors?.length) {
        return { success: false, message: `Hardcover GraphQL error: ${parsed.data.errors[0]!.message}` };
      }

      // A custom probe must apply the same list-resolution dispositions as a real
      // sync: `lists: []` → not-found/private, null/missing lists/list_books or a
      // null-id row → unexpected-response failure (AC9). A resolved list (including
      // resolved-empty and null-book-only rows) clears the probe.
      if (this.listType === 'custom') {
        try {
          this.validateRowIds(this.resolveRows(parsed.data));
        } catch (error: unknown) {
          return { success: false, message: getErrorMessage(error) };
        }
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${getErrorMessage(error)}` };
    }
  }

  // Minimal real query for the configured list type (limit 1) so `test()` exercises
  // the same fields a real sync uses.
  private buildProbe(): { query: string; variables: Record<string, unknown> } {
    if (this.listType === 'custom') {
      const { username, slug } = this.requireParsedUrl();
      // The operation declares `$offset: Int!`, so `offset` is required (AC9/F33).
      return { query: CUSTOM_LIST_QUERY, variables: { username, slug, limit: 1, offset: 0 } };
    }
    if (this.listType === 'shelf') {
      return { query: SHELF_QUERY, variables: { statusId: this.shelfId, limit: 1 } };
    }
    const { from, to } = trendingWindow();
    return { query: TRENDING_IDS_QUERY, variables: { from, to, limit: 1, offset: 0 } };
  }
}
