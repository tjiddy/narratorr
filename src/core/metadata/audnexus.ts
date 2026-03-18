import { BookMetadataSchema, AuthorMetadataSchema } from './schemas.js';
import { RateLimitError, TransientError } from './errors.js';
import { normalizeGenres } from './genres.js';
import type {
  MetadataProvider,
  BookMetadata,
  AuthorMetadata,
  SeriesMetadata,
  MetadataSearchResults,
  SearchBooksOptions,
} from './types.js';

export interface AudnexusConfig {
  region?: string;
}

const BASE_URL = 'https://api.audnex.us';
const REQUEST_TIMEOUT_MS = 15000;

export class AudnexusProvider implements MetadataProvider {
  readonly name = 'Audnexus';
  readonly type = 'audnexus';

  private region: string;

  constructor(config?: AudnexusConfig) {
    this.region = config?.region ?? 'us';
  }

  async search(query: string): Promise<MetadataSearchResults> {
    const authors = await this.searchAuthors(query);

    // Audnexus has no book search or author-books endpoint,
    // so search only returns author results.
    return {
      books: [],
      authors,
      series: [],
    };
  }

  async searchBooks(_query: string, _options?: SearchBooksOptions): Promise<BookMetadata[]> {
    // Audnexus does not support book search — use getBook(id) for direct lookup
    return [];
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    const data = await this.fetchJson<AudnexusAuthorSearchResult[]>(
      `/authors?name=${encodeURIComponent(query)}&region=${this.region}`,
    );

    if (!Array.isArray(data)) return [];

    const seen = new Set<string>();
    const authors: AuthorMetadata[] = [];
    for (const item of data) {
      // Audnexus returns duplicates; deduplicate by ASIN or name
      const key = item.asin ?? item.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const mapped = mapAuthor(item);
      const result = AuthorMetadataSchema.safeParse(mapped);
      if (result.success) {
        authors.push(result.data);
      }
    }
    return authors;
  }

  async searchSeries(_query: string): Promise<SeriesMetadata[]> {
    // Audnexus does not support series search directly
    return [];
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    const data = await this.fetchJson<AudnexusBookDetail>(
      `/books/${encodeURIComponent(id)}?region=${this.region}`,
    );

    if (!data) return null;

    const mapped = mapBook(data);
    const result = BookMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async getAuthor(id: string): Promise<AuthorMetadata | null> {
    const data = await this.fetchJson<AudnexusAuthorDetail>(
      `/authors/${encodeURIComponent(id)}?region=${this.region}`,
    );

    if (!data) return null;

    const mapped = mapAuthor(data);
    const result = AuthorMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async getAuthorBooks(_id: string): Promise<BookMetadata[]> {
    // Audnexus does not have an author-books endpoint
    return [];
  }

  async getSeries(_id: string): Promise<SeriesMetadata | null> {
    // Audnexus does not support series lookup directly
    return null;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${BASE_URL}/authors?name=test&region=${this.region}`,
        { signal: controller.signal },
      );

      if (response.ok) {
        return { success: true, message: 'Connected to Audnexus API' };
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

  private async fetchJson<T>(path: string): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${BASE_URL}${path}`, { signal: controller.signal });
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
        throw new RateLimitError(waitMs, 'Audnexus');
      }
      if (response.status >= 500) {
        throw new TransientError('Audnexus', `HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      if (error instanceof TransientError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientError('Audnexus', message);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Audnexus API response shapes (internal, not exported)
// ---------------------------------------------------------------------------

interface AudnexusAuthorSearchResult {
  asin?: string;
  name?: string;
  description?: string;
  image?: string;
  genres?: Array<{ name?: string }>;
}

type AudnexusAuthorDetail = AudnexusAuthorSearchResult;

interface AudnexusSeriesRef {
  name?: string;
  position?: string;
  asin?: string;
}

interface AudnexusBookDetail {
  asin?: string;
  isbn?: string;
  title?: string;
  subtitle?: string;
  authors?: Array<{ name?: string; asin?: string }>;
  narrators?: Array<{ name?: string }>;
  seriesPrimary?: AudnexusSeriesRef;
  seriesSecondary?: AudnexusSeriesRef;
  summary?: string;
  description?: string;
  publisherName?: string;
  releaseDate?: string;
  language?: string;
  image?: string;
  runtimeLengthMin?: number;
  genres?: Array<{ name?: string; type?: string }>;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapAuthor(d: AudnexusAuthorSearchResult): Record<string, unknown> {
  return {
    asin: d.asin,
    name: d.name ?? '',
    description: d.description,
    imageUrl: d.image || undefined,
    genres: normalizeGenres(d.genres?.map((g) => g.name).filter((n): n is string => Boolean(n))),
  };
}

function mapBook(d: AudnexusBookDetail): Record<string, unknown> {
  // Collect series from seriesPrimary/seriesSecondary
  const series: Array<{ name: string; position?: number; asin?: string }> = [];
  for (const ref of [d.seriesPrimary, d.seriesSecondary]) {
    if (ref?.name) {
      series.push({
        name: ref.name,
        position: ref.position != null ? parseFloat(ref.position) || undefined : undefined,
        asin: ref.asin,
      });
    }
  }

  return {
    asin: d.asin,
    title: d.title ?? '',
    subtitle: d.subtitle,
    authors: (d.authors ?? []).map((a) => ({
      name: a.name ?? '',
      asin: a.asin,
    })),
    narrators: d.narrators?.map((n) => n.name).filter(Boolean),
    series: series.length > 0 ? series : undefined,
    description: d.summary || d.description,
    publisher: d.publisherName,
    publishedDate: d.releaseDate,
    language: d.language,
    coverUrl: d.image || undefined,
    duration: d.runtimeLengthMin,
    genres: normalizeGenres(d.genres?.map((g) => g.name).filter((n): n is string => Boolean(n))),
  };
}
