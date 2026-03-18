import { BookMetadataSchema, AuthorMetadataSchema } from './schemas.js';
import { RateLimitError, TransientError } from './errors.js';
import { normalizeGenres } from './genres.js';
import { AUDNEXUS_TIMEOUT_MS } from '../utils/constants.js';
import type {
  MetadataEnrichmentProvider,
  BookMetadata,
  AuthorMetadata,
} from './types.js';

export interface AudnexusConfig {
  region?: string;
}

const BASE_URL = 'https://api.audnex.us';
const REQUEST_TIMEOUT_MS = AUDNEXUS_TIMEOUT_MS;

export class AudnexusProvider implements MetadataEnrichmentProvider {
  readonly name = 'Audnexus';
  readonly type = 'audnexus';

  private region: string;

  constructor(config?: AudnexusConfig) {
    this.region = config?.region ?? 'us';
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
