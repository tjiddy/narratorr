import { z } from 'zod';
import { BookMetadataSchema, AuthorMetadataSchema } from './schemas.js';
import { MetadataError, RateLimitError, TransientError } from './errors.js';
import { normalizeGenres } from './genres.js';
import { AUDNEXUS_TIMEOUT_MS } from '../utils/constants.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { getErrorMessage } from '../../shared/error-message.js';
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

// Raw-response schemas at the wrapper layer — fail at the boundary on HTML
// interstitials, rate-limit pages, or shape changes instead of mid-mapping.
const audnexusSeriesRefSchema = z.object({
  name: z.string().nullish(),
  position: z.string().nullish(),
  asin: z.string().nullish(),
}).passthrough();

const audnexusBookSchema = z.object({
  asin: z.string().nullish(),
  isbn: z.string().nullish(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  authors: z.array(z.object({ name: z.string().nullish(), asin: z.string().nullish() }).passthrough()).nullish(),
  narrators: z.array(z.object({ name: z.string().nullish() }).passthrough()).nullish(),
  seriesPrimary: audnexusSeriesRefSchema.nullish(),
  seriesSecondary: audnexusSeriesRefSchema.nullish(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  publisherName: z.string().nullish(),
  releaseDate: z.string().nullish(),
  language: z.string().nullish(),
  image: z.string().nullish(),
  runtimeLengthMin: z.number().nullish(),
  genres: z.array(z.object({ name: z.string().nullish(), type: z.string().nullish() }).passthrough()).nullish(),
}).passthrough();

const audnexusAuthorSchema = z.object({
  asin: z.string().nullish(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  image: z.string().nullish(),
  genres: z.array(z.object({ name: z.string().nullish() }).passthrough()).nullish(),
}).passthrough();

type AudnexusBookDetail = z.infer<typeof audnexusBookSchema>;
type AudnexusAuthorDetail = z.infer<typeof audnexusAuthorSchema>;

export class AudnexusProvider implements MetadataEnrichmentProvider {
  readonly name = 'Audnexus';
  readonly type = 'audnexus';

  private region: string;

  constructor(config?: AudnexusConfig) {
    this.region = config?.region ?? 'us';
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    const data = await this.fetchJson(
      `/books/${encodeURIComponent(id)}?region=${this.region}`,
      audnexusBookSchema,
    );

    if (!data) return null;

    const mapped = mapBook(data);
    const result = BookMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async getAuthor(id: string): Promise<AuthorMetadata | null> {
    const data = await this.fetchJson(
      `/authors/${encodeURIComponent(id)}?region=${this.region}`,
      audnexusAuthorSchema,
    );

    if (!data) return null;

    const mapped = mapAuthor(data);
    const result = AuthorMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  private async fetchJson<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S> | null> {
    try {
      const response = await fetchWithTimeout(`${BASE_URL}${path}`, {}, REQUEST_TIMEOUT_MS);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
        throw new RateLimitError(waitMs, 'Audnexus');
      }
      if (response.status >= 500) {
        throw new TransientError('Audnexus', `HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.ok) return null;
      const raw: unknown = await response.json();
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new MetadataError(
          'Audnexus',
          `Audnexus returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof RateLimitError) throw error;
      if (error instanceof TransientError) throw error;
      if (error instanceof MetadataError) throw error;
      throw new TransientError('Audnexus', getErrorMessage(error));
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapAuthor(d: AudnexusAuthorDetail): Record<string, unknown> {
  return {
    asin: d.asin ?? undefined,
    name: d.name ?? '',
    description: d.description ?? undefined,
    imageUrl: d.image || undefined,
    genres: normalizeGenres(d.genres?.map((g) => g.name).filter((n): n is string => Boolean(n))),
  };
}

function mapSeriesRefs(
  d: AudnexusBookDetail,
): Array<{ name: string; position?: number; asin?: string }> | undefined {
  const out: Array<{ name: string; position?: number; asin?: string }> = [];
  for (const ref of [d.seriesPrimary, d.seriesSecondary]) {
    if (ref?.name) {
      out.push({
        name: ref.name,
        position: ref.position != null ? parseFloat(ref.position) || undefined : undefined,
        asin: ref.asin ?? undefined,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function mapBookAuthors(d: AudnexusBookDetail): Array<{ name: string; asin?: string }> {
  return (d.authors ?? []).map((a) => ({
    name: a.name ?? '',
    asin: a.asin ?? undefined,
  }));
}

function mapBook(d: AudnexusBookDetail): Record<string, unknown> {
  return {
    asin: d.asin ?? undefined,
    title: d.title ?? '',
    subtitle: d.subtitle ?? undefined,
    authors: mapBookAuthors(d),
    narrators: d.narrators?.map((n) => n.name).filter((n): n is string => Boolean(n)),
    series: mapSeriesRefs(d),
    description: d.summary || d.description || undefined,
    publisher: d.publisherName ?? undefined,
    publishedDate: d.releaseDate ?? undefined,
    language: d.language ?? undefined,
    coverUrl: d.image || undefined,
    duration: d.runtimeLengthMin ?? undefined,
    genres: normalizeGenres(d.genres?.map((g) => g.name).filter((n): n is string => Boolean(n))),
  };
}
