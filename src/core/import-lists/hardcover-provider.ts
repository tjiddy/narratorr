import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { formatZodError } from './format-zod-error.js';
import { getErrorMessage } from '@shared/error-message.js';
import { IMPORT_LIST_TIMEOUT_MS } from '../utils/constants.js';
import {
  createRateLimitBudget,
  fetchHardcoverGraphQL,
  normalizeHardcoverApiKey,
  scopeGuidanceSentence,
  TOP_LEVEL_LIMIT_EXCEEDED,
  type HardcoverFetchFailure,
  type HardcoverRateLimitBudget,
} from '../utils/hardcover-http.js';
import { parseHardcoverListUrl } from '@shared/hardcover-list-url.js';
import type { HardcoverListType, HardcoverImportMax } from '@shared/hardcover-list-types.js';

export interface HardcoverConfig {
  apiKey: string;
  listType: HardcoverListType;
  shelfId?: number;
  listUrl?: string;
  importMax?: HardcoverImportMax;
}

// Cap full custom-list pages independently of untrusted books_count.
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;

const NOT_FOUND_MSG = 'List not found or private';
const UNEXPECTED_LISTS_MSG = 'Hardcover returned an unexpected response (missing lists)';
const UNEXPECTED_ROWS_MSG = 'Hardcover returned an unexpected response (missing list_books)';
const UNEXPECTED_ROW_ID_MSG = 'Hardcover returned an unexpected response (list row without a numeric id)';
const REPEATED_PAGE_MSG = 'Hardcover returned a repeated page (offset appears to be ignored)';
const RUNAWAY_MSG = 'Hardcover list exceeds the supported size (pagination runaway guard)';
const BAD_URL_MSG = 'Not a Hardcover list URL';

// books_trending ranks over the fixed window ending today.
const TRENDING_WINDOW_DAYS = 7;
const TRENDING_LIMIT = 50;
const SHELF_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// Trending and shelf both resolve GraphQL books; share one projection with mapBook.
// Depth watch (#2537): Hardcover's roadmap limits query depth to 3 in 2026. Inlined into
// CUSTOM_LIST_QUERY this reaches list_books → book → default_audio_edition → image → url (~6),
// so that limit breaks every query in this file, and the metadata client's, at once.
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

// books_trending returns ranked IDs; a second query resolves book objects.
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

// Private/unresolved lists return lists: []. Hasura multi-column order must use an
// array of single-key objects; key order inside one object is not preserved.
// Depth watch (#2537): the deepest query here — lists → list_books → book →
// default_audio_edition → image → url (~6) against a roadmapped depth-3 limit.
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
  // External fields may be null or omitted; print editions omit image.
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

// Parse external fields as nullish; resolution below enforces required IDs and rows.
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

// Derive the full-page budget once, capped; invalid counts fall back to the cap.
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

// Prefer audiobook identifiers because narratorr matches Audible ASINs.
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
    // Prefer the audiobook cover; fall back to the book's print image.
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

/**
 * The probe reports a disposition rather than the sync's free-form message: a throttle and a
 * structural refusal both arrive as a 429, but only one is worth waiting out.
 */
function probeFailureMessage(failure: HardcoverFetchFailure): string {
  if (failure.code === TOP_LEVEL_LIMIT_EXCEEDED) return failure.message;
  if (failure.status === 429) return 'Hardcover is rate-limiting requests. Try again shortly.';
  const suffix = failure.suffix ?? '';
  // Before the 401/403 arm, which would shadow it: an under-scoped token is correctly typed, so
  // "Invalid API key" misdirects the operator into regenerating a key that was never wrong (#2554).
  if (failure.code === 'insufficient_scope') return `${scopeGuidanceSentence(failure.scope)}${suffix}`;
  if (failure.status === 401 || failure.status === 403) return `Invalid API key${suffix}`;
  return `API returned ${failure.status}: ${failure.statusText}${suffix}`;
}

export class HardcoverProvider implements ImportListProvider {
  readonly type = 'hardcover';
  readonly name = 'Hardcover';

  private apiKey: string;
  private listType: HardcoverListType;
  private shelfId?: number;
  private listUrl?: string;
  private importMax?: HardcoverImportMax;

  constructor(config: HardcoverConfig) {
    this.apiKey = normalizeHardcoverApiKey(config.apiKey);
    this.listType = config.listType;
    if (config.shelfId !== undefined) this.shelfId = config.shelfId;
    if (config.listUrl !== undefined) this.listUrl = config.listUrl;
    if (config.importMax !== undefined) this.importMax = config.importMax;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    // Call-local by construction: two fetchItems() on one instance — concurrent or sequential —
    // each get an independent full wait budget, with no reset step and no ordering invariant.
    const budget = createRateLimitBudget();
    if (this.listType === 'custom') return this.fetchCustomList(budget);
    return this.listType === 'shelf' ? this.fetchShelf(budget) : this.fetchTrending(budget);
  }

  private async fetchCustomList(budget: HardcoverRateLimitBudget): Promise<ImportListItem[]> {
    const { username, slug } = this.requireParsedUrl();
    const importMax = this.importMax ?? 50;
    if (importMax === 'all') return this.fetchAllPages(username, slug, budget);

    const data = await this.executeQuery(CUSTOM_LIST_QUERY, { username, slug, limit: importMax, offset: 0 }, budget);
    const rows = this.resolveRows(data);
    this.validateRowIds(rows);
    return this.emitRows(rows, new Set<number>());
  }

  // Deduplicate raw row IDs before mapping so dropped books still consume their slot.
  private async fetchAllPages(username: string, slug: string, budget: HardcoverRateLimitBudget): Promise<ImportListItem[]> {
    const seen = new Set<number>();
    const items: ImportListItem[] = [];
    let offset = 0;
    let fullPageBudget = MAX_LIST_PAGES;
    let budgetFrozen = false;
    let fullPagesFetched = 0;

    for (;;) {
      const data = await this.executeQuery(CUSTOM_LIST_QUERY, { username, slug, limit: PAGE_SIZE, offset }, budget);
      const list = this.resolveList(data);
      const rows = this.requireRows(list);
      this.validateRowIds(rows);

      if (!budgetFrozen) {
        // Later responses cannot move the first response's budget.
        fullPageBudget = customPageBudget(list.books_count);
        budgetFrozen = true;
      }

      const isFullPage = rows.length === PAGE_SIZE;
      const newRows = rows.filter((row) => !seen.has(row.id as number));
      // A full page with no new IDs means the server ignored offset.
      if (isFullPage && newRows.length === 0) throw new ImportListError(this.name, REPEATED_PAGE_MSG);

      items.push(...this.emitRows(newRows, seen));

      // The budget counts only full pages; a terminal short page is always valid.
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

  // [] means not-found/private; null or missing means malformed.
  private resolveList(data: HardcoverResponse): HardcoverList {
    const lists = data.data?.lists;
    if (lists == null) throw new ImportListError(this.name, UNEXPECTED_LISTS_MSG);
    if (lists.length === 0) throw new ImportListError(this.name, NOT_FOUND_MSG);
    return lists[0]!;
  }

  // [] is a valid empty list; null or missing rows are malformed.
  private requireRows(list: HardcoverList): HardcoverListBook[] {
    const rows = list.list_books;
    if (rows == null) throw new ImportListError(this.name, UNEXPECTED_ROWS_MSG);
    return rows;
  }

  private resolveRows(data: HardcoverResponse): HardcoverListBook[] {
    return this.requireRows(this.resolveList(data));
  }

  // Raw IDs are the pagination dedup and loop-guard key.
  private validateRowIds(rows: HardcoverListBook[]): void {
    for (const row of rows) {
      if (typeof row.id !== 'number') throw new ImportListError(this.name, UNEXPECTED_ROW_ID_MSG);
    }
  }

  // Emit unseen rows in order; unmappable books still consume their ID slot before being dropped.
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

  private async fetchTrending(budget: HardcoverRateLimitBudget): Promise<ImportListItem[]> {
    const { from, to } = trendingWindow();
    const idsData = await this.executeQuery(TRENDING_IDS_QUERY, {
      from, to, limit: TRENDING_LIMIT, offset: 0,
    }, budget);

    const ids = idsData.data?.books_trending?.ids ?? [];
    if (ids.length === 0) return [];

    const booksData = await this.executeQuery(BOOKS_BY_IDS_QUERY, { ids }, budget);

    // The second query is unordered; restore the ranking from books_trending.ids.
    const byId = new Map<number, ImportListItem>();
    for (const book of booksData.data?.books ?? []) {
      const item = mapBook(book);
      if (item && typeof book.id === 'number') byId.set(book.id, item);
    }
    return ids.map((id) => byId.get(id)).filter((item): item is ImportListItem => item != null);
  }

  private async fetchShelf(budget: HardcoverRateLimitBudget): Promise<ImportListItem[]> {
    const data = await this.executeQuery(SHELF_QUERY, { statusId: this.shelfId, limit: SHELF_LIMIT }, budget);
    return (data.data?.user_books ?? [])
      .map((entry) => entry.book)
      .filter((book): book is HardcoverBook => book != null)
      .map(mapBook)
      .filter((item): item is ImportListItem => item != null);
  }

  // The single chokepoint for all five request sites, so 429 backoff covers every list type
  // and every page without any caller opting in.
  private async executeQuery(
    query: string,
    variables: Record<string, unknown> | undefined,
    budget: HardcoverRateLimitBudget,
  ): Promise<HardcoverResponse> {
    const outcome = await fetchHardcoverGraphQL({
      apiKey: this.apiKey, query, variables, timeoutMs: IMPORT_LIST_TIMEOUT_MS, budget,
    });
    if (!outcome.ok) throw new ImportListError(this.name, outcome.message);

    const raw: unknown = await outcome.response.json();
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
      // Single-shot: the settings Test button is synchronous and operator-facing, so a hidden
      // 60s backoff would read as a hang.
      const outcome = await fetchHardcoverGraphQL({
        apiKey: this.apiKey, query, variables, timeoutMs: IMPORT_LIST_TIMEOUT_MS, budget: null,
      });
      if (!outcome.ok) return { success: false, message: probeFailureMessage(outcome) };

      const raw: unknown = await outcome.response.json();
      const parsed = hardcoverResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return { success: false, message: `Validation failed: ${formatZodError(parsed.error)}` };
      }
      // A real query exposes field-level schema drift that __typename cannot.
      if (parsed.data.errors?.length) {
        return { success: false, message: `Hardcover GraphQL error: ${parsed.data.errors[0]!.message}` };
      }

      // Probe with the same not-found/malformed dispositions as a real sync.
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

  // Probe the configured list type with the real projection at limit 1.
  private buildProbe(): { query: string; variables: Record<string, unknown> } {
    if (this.listType === 'custom') {
      const { username, slug } = this.requireParsedUrl();
      return { query: CUSTOM_LIST_QUERY, variables: { username, slug, limit: 1, offset: 0 } };
    }
    if (this.listType === 'shelf') {
      return { query: SHELF_QUERY, variables: { statusId: this.shelfId, limit: 1 } };
    }
    const { from, to } = trendingWindow();
    return { query: TRENDING_IDS_QUERY, variables: { from, to, limit: 1, offset: 0 } };
  }
}
