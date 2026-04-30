import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface HardcoverConfig {
  apiKey: string;
  listType: 'trending' | 'shelf';
  shelfId?: number;
}

const GRAPHQL_URL = 'https://api.hardcover.app/v1/graphql';

const TRENDING_QUERY = `
  query TrendingBooks {
    trending_books(limit: 50) {
      title
      contributions {
        author { name }
      }
      identifiers {
        source { name }
        value
      }
    }
  }
`;

const SHELF_QUERY = `
  query ShelfBooks($shelfId: bigint!) {
    user_book_reads(where: { status_id: { _eq: $shelfId } }, limit: 100) {
      book {
        title
        contributions {
          author { name }
        }
        identifiers {
          source { name }
          value
        }
      }
    }
  }
`;

const hardcoverBookSchema = z.object({
  title: z.string().optional(),
  contributions: z.array(z.object({
    author: z.object({ name: z.string().optional() }).passthrough().optional(),
  }).passthrough()).optional(),
  identifiers: z.array(z.object({
    source: z.object({ name: z.string().optional() }).passthrough().optional(),
    value: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

type HardcoverBook = z.infer<typeof hardcoverBookSchema>;

const hardcoverResponseSchema = z.object({
  data: z.object({
    trending_books: z.array(hardcoverBookSchema).optional(),
    user_book_reads: z.array(z.object({ book: hardcoverBookSchema }).passthrough()).optional(),
  }).passthrough().optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
}).passthrough();

// Probe response for `test()`: `{ __typename }` should return a `data` object
// with a `__typename` string. Schema is intentionally loose — `errors` can also
// be present with a string-message array.
const hardcoverProbeResponseSchema = z.object({
  data: z.object({ __typename: z.string() }).passthrough().nullish(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).nullish(),
}).passthrough();

function mapBook(book: HardcoverBook): ImportListItem | null {
  if (!book.title) return null;
  const author = book.contributions?.[0]?.author?.name || undefined;
  const asinEntry = book.identifiers?.find((id) => id.source?.name === 'amazon');
  const isbnEntry = book.identifiers?.find((id) => id.source?.name === 'isbn_13' || id.source?.name === 'isbn');

  return {
    title: book.title,
    author,
    asin: asinEntry?.value || undefined,
    isbn: isbnEntry?.value || undefined,
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
    this.shelfId = config.shelfId;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    const data = await this.executeQuery();

    if (data.errors?.length) {
      throw new ImportListError(this.name, `Hardcover GraphQL error: ${data.errors[0].message}`);
    }

    const books = this.listType === 'shelf'
      ? (data.data?.user_book_reads ?? []).map((r) => r.book)
      : (data.data?.trending_books ?? []);

    return books.map(mapBook).filter((item) => item !== null);
  }

  private async executeQuery(): Promise<z.infer<typeof hardcoverResponseSchema>> {
    const useShelf = this.listType === 'shelf' && this.shelfId !== undefined;
    const query = useShelf ? SHELF_QUERY : TRENDING_QUERY;
    const variables = useShelf ? { shelfId: this.shelfId } : undefined;

    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });

    if (!res.ok) {
      throw new ImportListError(this.name, `Hardcover API returned ${res.status}: ${res.statusText}`);
    }

    const raw: unknown = await res.json();
    const parsed = hardcoverResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ImportListError(
        this.name,
        `Hardcover returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });

      if (res.status === 401 || res.status === 403) {
        return { success: false, message: 'Invalid API key' };
      }

      if (!res.ok) {
        return { success: false, message: `API returned ${res.status}: ${res.statusText}` };
      }

      const raw: unknown = await res.json();
      const parsed = hardcoverProbeResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          success: false,
          message: `Validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        };
      }
      const data = parsed.data;
      if (data.errors?.length) {
        return { success: false, message: `Hardcover GraphQL error: ${data.errors[0].message}` };
      }
      if (!data.data?.__typename) {
        return { success: false, message: 'Hardcover probe returned no data.__typename field' };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${getErrorMessage(error)}` };
    }
  }
}
