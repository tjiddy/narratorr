import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { formatZodError } from './format-zod-error.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { IMPORT_LIST_TIMEOUT_MS } from '../utils/constants.js';

export interface HardcoverConfig {
  apiKey: string;
  listType: 'trending' | 'shelf';
  shelfId?: number;
}

const GRAPHQL_URL = 'https://api.hardcover.app/v1/graphql';

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

const hardcoverResponseSchema = z.object({
  data: z.object({
    books_trending: z.object({ ids: z.array(z.number()).nullish() }).passthrough().nullish(),
    books: z.array(hardcoverBookSchema).nullish(),
    user_books: z.array(z.object({ book: hardcoverBookSchema.nullish() }).passthrough()).nullish(),
  }).passthrough().nullish(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).nullish(),
}).passthrough();

type HardcoverResponse = z.infer<typeof hardcoverResponseSchema>;

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
  private listType: 'trending' | 'shelf';
  private shelfId?: number;

  constructor(config: HardcoverConfig) {
    this.apiKey = config.apiKey;
    this.listType = config.listType;
    if (config.shelfId !== undefined) this.shelfId = config.shelfId;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    return this.listType === 'shelf' ? this.fetchShelf() : this.fetchTrending();
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

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${getErrorMessage(error)}` };
    }
  }

  // Minimal real query for the configured list type (limit 1) so `test()` exercises
  // the same fields a real sync uses.
  private buildProbe(): { query: string; variables: Record<string, unknown> } {
    if (this.listType === 'shelf') {
      return { query: SHELF_QUERY, variables: { statusId: this.shelfId, limit: 1 } };
    }
    const { from, to } = trendingWindow();
    return { query: TRENDING_IDS_QUERY, variables: { from, to, limit: 1, offset: 0 } };
  }
}
