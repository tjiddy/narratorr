import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface NytConfig {
  apiKey: string;
  list: string; // e.g., 'audio-fiction', 'audio-nonfiction'
}

const nytBookSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  primary_isbn13: z.string().optional(),
  primary_isbn10: z.string().optional(),
}).passthrough();

const nytResponseSchema = z.object({
  results: z.object({
    books: z.array(nytBookSchema),
  }).passthrough(),
}).passthrough();

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
      throw new ImportListError(this.name, 'NYT API rate limit exceeded');
    }

    if (!res.ok) {
      throw new ImportListError(this.name, `NYT API returned ${res.status}: ${res.statusText}`);
    }

    const raw: unknown = await res.json();
    const parsed = nytResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ImportListError(
        this.name,
        `NYT returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    const books = parsed.data.results.books;

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

      const raw: unknown = await res.json();
      const parsed = nytResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return { success: false, message: `Validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${getErrorMessage(error)}` };
    }
  }
}
