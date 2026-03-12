import type { ImportListProvider, ImportListItem } from './types.js';

export interface HardcoverConfig {
  apiKey: string;
  listType: 'trending' | 'shelf';
  shelfId?: string;
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

function shelfQuery(shelfId: string) {
  return `
    query ShelfBooks {
      user_book_reads(where: { status_id: { _eq: ${shelfId} } }, limit: 100) {
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
}

interface HardcoverBook {
  title?: string;
  contributions?: Array<{ author?: { name?: string } }>;
  identifiers?: Array<{ source?: { name?: string }; value?: string }>;
}

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
  private shelfId?: string;

  constructor(config: HardcoverConfig) {
    this.apiKey = config.apiKey;
    this.listType = config.listType;
    this.shelfId = config.shelfId;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    const query = this.listType === 'shelf' && this.shelfId
      ? shelfQuery(this.shelfId)
      : TRENDING_QUERY;

    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      throw new Error(`Hardcover API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as {
      data?: {
        trending_books?: HardcoverBook[];
        user_book_reads?: Array<{ book: HardcoverBook }>;
      };
      errors?: Array<{ message: string }>;
    };

    if (data.errors?.length) {
      throw new Error(`Hardcover GraphQL error: ${data.errors[0].message}`);
    }

    const books = this.listType === 'shelf'
      ? (data.data?.user_book_reads ?? []).map((r) => r.book)
      : (data.data?.trending_books ?? []);

    return books.map(mapBook).filter((item): item is ImportListItem => item !== null);
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

      return { success: true };
    } catch (err) {
      return { success: false, message: `Connection failed: ${(err as Error).message}` };
    }
  }
}
