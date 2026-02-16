import { BookMetadataSchema, AuthorMetadataSchema } from './schemas.js';
import { RateLimitError } from './errors.js';
import type {
  MetadataProvider,
  BookMetadata,
  AuthorMetadata,
  SeriesMetadata,
  MetadataSearchResults,
} from './types.js';

export interface GoogleBooksConfig {
  apiKey: string;
}

const BASE_URL = 'https://www.googleapis.com/books/v1/volumes';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESULTS = 20;

export class GoogleBooksProvider implements MetadataProvider {
  readonly name = 'Google Books';
  readonly type = 'google-books';

  private apiKey: string;

  constructor(config: GoogleBooksConfig) {
    this.apiKey = config.apiKey;
  }

  async search(query: string): Promise<MetadataSearchResults> {
    const books = await this.searchBooks(query);

    // Deduplicate authors from book results
    const authorMap = new Map<string, AuthorMetadata>();
    for (const book of books) {
      for (const authorRef of book.authors) {
        if (!authorMap.has(authorRef.name)) {
          const mapped = AuthorMetadataSchema.safeParse({
            name: authorRef.name,
          });
          if (mapped.success) {
            authorMap.set(authorRef.name, mapped.data);
          }
        }
      }
    }

    return {
      books,
      authors: Array.from(authorMap.values()),
      series: [],
    };
  }

  async searchBooks(query: string): Promise<BookMetadata[]> {
    const data = await this.fetchApi<GoogleBooksSearchResponse>(
      `?q=${encodeURIComponent(query)}&key=${this.apiKey}&maxResults=${MAX_RESULTS}`,
    );

    if (!data?.items) return [];

    const books: BookMetadata[] = [];
    for (const item of data.items) {
      const mapped = mapVolume(item);
      const result = BookMetadataSchema.safeParse(mapped);
      if (result.success) {
        books.push(result.data);
      }
    }
    return books;
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    // Google Books has no author endpoint — simulate by searching inauthor: prefix
    const data = await this.fetchApi<GoogleBooksSearchResponse>(
      `?q=inauthor:${encodeURIComponent(query)}&key=${this.apiKey}&maxResults=${MAX_RESULTS}`,
    );

    if (!data?.items) return [];

    // Deduplicate authors from search results
    const authorMap = new Map<string, AuthorMetadata>();
    for (const item of data.items) {
      const authorNames = item.volumeInfo?.authors ?? [];
      for (const name of authorNames) {
        const lower = name.toLowerCase();
        if (!authorMap.has(lower) && lower.includes(query.toLowerCase())) {
          const mapped = AuthorMetadataSchema.safeParse({ name });
          if (mapped.success) {
            authorMap.set(lower, mapped.data);
          }
        }
      }
    }

    return Array.from(authorMap.values());
  }

  async searchSeries(_query: string): Promise<SeriesMetadata[]> {
    // Google Books has no series concept
    return [];
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    // Try direct volume lookup first
    const data = await this.fetchApi<GoogleBooksVolume>(`/${encodeURIComponent(id)}?key=${this.apiKey}`);

    if (!data?.volumeInfo) return null;

    const mapped = mapVolume(data);
    const result = BookMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async getAuthor(_id: string): Promise<AuthorMetadata | null> {
    // Google Books has no author detail endpoint
    return null;
  }

  async getAuthorBooks(id: string): Promise<BookMetadata[]> {
    // Use id as author name for search
    return this.searchBooks(`inauthor:"${id}"`);
  }

  async getSeries(_id: string): Promise<SeriesMetadata | null> {
    // Google Books has no series concept
    return null;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${BASE_URL}?q=test&key=${this.apiKey}&maxResults=1`,
        { signal: controller.signal },
      );

      if (response.ok) {
        return { success: true, message: 'Connected to Google Books API' };
      }

      if (response.status === 403) {
        return { success: false, message: 'API key invalid or quota exceeded' };
      }

      return {
        success: false,
        message: `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchApi<T>(path: string): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
      if (response.status === 429 || (response.status === 403 && response.statusText.toLowerCase().includes('rate'))) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
        throw new RateLimitError(waitMs, 'Google Books');
      }
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Google Books API response shapes (internal, not exported)
// ---------------------------------------------------------------------------

interface GoogleBooksSearchResponse {
  totalItems?: number;
  items?: GoogleBooksVolume[];
}

interface GoogleBooksVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    categories?: string[];
    imageLinks?: {
      thumbnail?: string;
      smallThumbnail?: string;
    };
    language?: string;
  };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapVolume(item: GoogleBooksVolume): Record<string, unknown> {
  const info = item.volumeInfo;
  if (!info) return { title: '', authors: [] };

  // Extract ISBN (prefer ISBN_13, fallback to ISBN_10)
  const isbn = extractIsbn(info.industryIdentifiers);

  // Cover URL — upgrade to HTTPS
  const coverUrl = normalizeCoverUrl(info.imageLinks?.thumbnail);

  // Sanitize HTML from description
  const description = info.description ? stripHtml(info.description) : undefined;

  return {
    providerId: item.id,
    title: info.title ?? '',
    subtitle: info.subtitle,
    authors: (info.authors ?? []).map((name) => ({ name })),
    description,
    publisher: info.publisher,
    publishedDate: info.publishedDate,
    language: info.language,
    coverUrl,
    isbn,
    genres: info.categories,
    // Fields not available from Google Books
    asin: undefined,
    narrators: undefined,
    duration: undefined,
    series: undefined,
  };
}

function extractIsbn(
  identifiers?: Array<{ type?: string; identifier?: string }>,
): string | undefined {
  if (!identifiers) return undefined;
  const isbn13 = identifiers.find((i) => i.type === 'ISBN_13');
  if (isbn13?.identifier) return isbn13.identifier;
  const isbn10 = identifiers.find((i) => i.type === 'ISBN_10');
  return isbn10?.identifier;
}

function normalizeCoverUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/^http:\/\//, 'https://');
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}
