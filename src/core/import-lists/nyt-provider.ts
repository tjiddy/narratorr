import type { ImportListProvider, ImportListItem } from './types.js';

export interface NytConfig {
  apiKey: string;
  list: string; // e.g., 'audio-fiction', 'audio-nonfiction'
}

interface NytBook {
  title?: string;
  author?: string;
  primary_isbn13?: string;
  primary_isbn10?: string;
}

interface NytResponse {
  results?: {
    books?: NytBook[];
  };
}

export class NytProvider implements ImportListProvider {
  readonly type = 'nyt';
  readonly name = 'NYT Bestsellers';

  private apiKey: string;
  private list: string;

  constructor(config: NytConfig) {
    this.apiKey = config.apiKey;
    this.list = config.list;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    const url = `https://api.nytimes.com/svc/books/v3/lists/current/${this.list}.json?api-key=${this.apiKey}`;
    const res = await fetch(url);

    if (res.status === 429) {
      throw new Error('NYT API rate limit exceeded');
    }

    if (!res.ok) {
      throw new Error(`NYT API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as NytResponse;
    const books = data.results?.books ?? [];

    const items: ImportListItem[] = [];
    for (const book of books) {
      if (!book.title) continue;
      items.push({
        title: book.title,
        author: book.author || undefined,
        isbn: book.primary_isbn13 || book.primary_isbn10 || undefined,
      });
    }
    return items;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const url = `https://api.nytimes.com/svc/books/v3/lists/current/${this.list}.json?api-key=${this.apiKey}`;
      const res = await fetch(url);

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
