import { z } from 'zod';
import { BookMetadataSchema, AuthorMetadataSchema } from './schemas.js';
import { MetadataError, RateLimitError, TransientError } from './errors.js';
import { normalizeGenres } from './genres.js';
import { computeTrimmedChapterRuntime } from './chapter-trim.js';
// Every 429 path uses the shared normalizer so provider backoff receives a valid window.
import { parseRetryAfterMs } from './retry-after.js';
import { AUDNEXUS_TIMEOUT_MS } from '../utils/constants.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { getErrorMessage } from '@shared/error-message.js';
import type {
  MetadataEnrichmentProvider,
  BookMetadata,
  AuthorMetadata,
  ChapterRuntimeOutcome,
  ProviderLookupResult,
} from './types.js';

export interface AudnexusConfig {
  region?: string;
}

const BASE_URL = 'https://api.audnex.us';
const REQUEST_TIMEOUT_MS = AUDNEXUS_TIMEOUT_MS;

// Reject HTML interstitials and upstream shape drift at the response boundary.
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

/**
 * Malformed entries stop trimming but must not invalidate an authoritative chapter record;
 * `.catch({})` prevents a transient re-request loop.
 */
const audnexusChapterEntrySchema = z.object({
  title: z.string().nullish(),
  lengthMs: z.number().nullish(),
}).passthrough().catch({});

/**
 * Published runtime stays primary; entries derive only the trimmed alternative. Nullable trust
 * fields still parse because identity and record shape establish authority below.
 */
const audnexusChaptersSchema = z.object({
  asin: z.string().nullish(),
  runtimeLengthMs: z.number().nullish(),
  isAccurate: z.boolean().nullish(),
  chapters: z.array(audnexusChapterEntrySchema).nullish(),
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
    const r = await this.getBookDetailed(id);
    switch (r.kind) {
      case 'ok': return r.book;
      case 'not_found': return null;
      case 'invalid_record':
        if (r.source === 'raw') {
          throw new MetadataError(
            'Audnexus',
            'Audnexus returned unexpected response',
            r.cause !== undefined ? { cause: r.cause } : undefined,
          );
        }
        return null;
      case 'rate_limited': throw new RateLimitError(r.retryAfterMs, 'Audnexus');
      case 'transient_failure': throw new TransientError('Audnexus', r.message);
    }
  }

  /** Never throws; every lookup failure becomes a discriminated outcome. */
  async getBookDetailed(id: string): Promise<ProviderLookupResult> {
    const raw = await this.fetchJsonDetailed(
      `/books/${encodeURIComponent(id)}?region=${this.region}`,
      audnexusBookSchema,
    );
    if (raw.kind !== 'ok') return raw;

    if (!raw.data) return { kind: 'not_found' };

    const mapped = mapBook(raw.data);
    const parsed = BookMetadataSchema.safeParse(mapped);
    if (!parsed.success) {
      return { kind: 'invalid_record', source: 'mapped', cause: parsed.error, issues: parsed.error.issues };
    }
    return { kind: 'ok', book: parsed.data };
  }

  /**
   * Region-scoped chapter lookup with cache-safe outcomes: only documented 400/404 are absent,
   * only exact 200 parses, and pre-header or body-stream failures remain transient. Never throws.
   */
  async getChapterRuntime(id: string): Promise<ChapterRuntimeOutcome> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${BASE_URL}/books/${encodeURIComponent(id)}/chapters?region=${encodeURIComponent(this.region)}`,
        {},
        REQUEST_TIMEOUT_MS,
      );
    } catch (error: unknown) {
      // Network, timeout, TLS, DNS, and rejected redirects fail before headers.
      return { kind: 'transient_failure', message: getErrorMessage(error) };
    }

    if (response.status === 429) {
      return { kind: 'rate_limited', retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')) };
    }
    // Only these statuses document an absent or invalid ASIN.
    if (response.status === 400 || response.status === 404) return { kind: 'not_found' };
    // Require exact 200; response.ok also accepts other successful 2xx statuses.
    if (response.status !== 200) {
      return { kind: 'transient_failure', message: `HTTP ${response.status} ${response.statusText}` };
    }

    // The timeout signal remains attached, so the body stream can fail after headers.
    let body: string;
    try {
      body = await response.text();
    } catch (error: unknown) {
      return { kind: 'transient_failure', message: getErrorMessage(error) };
    }

    return classifyChapterBody(body, id);
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
        throw new RateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')), 'Audnexus');
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

  /** Like `fetchJson`, but returns a discriminated outcome instead of throwing. */
  private async fetchJsonDetailed<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
  ): Promise<
    | { kind: 'ok'; data: z.infer<S> | null }
    | { kind: 'not_found' }
    | { kind: 'rate_limited'; retryAfterMs: number }
    | { kind: 'invalid_record'; source: 'raw'; cause: z.ZodError; issues: z.ZodIssue[] }
    | { kind: 'transient_failure'; message: string }
  > {
    let response: Response;
    try {
      response = await fetchWithTimeout(`${BASE_URL}${path}`, {}, REQUEST_TIMEOUT_MS);
    } catch (error: unknown) {
      return { kind: 'transient_failure', message: getErrorMessage(error) };
    }
    if (response.status === 429) {
      return { kind: 'rate_limited', retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')) };
    }
    if (response.status >= 500) {
      return { kind: 'transient_failure', message: `HTTP ${response.status} ${response.statusText}` };
    }
    if (!response.ok) return { kind: 'not_found' };
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error: unknown) {
      return { kind: 'transient_failure', message: getErrorMessage(error) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'invalid_record', source: 'raw', cause: parsed.error, issues: parsed.error.issues };
    }
    return { kind: 'ok', data: parsed.data };
  }
}

/**
 * Authority requires both the requested ASIN and a chapter array. Either alone can admit a
 * wrong edition or error envelope, so failures stay transient `invalid_record` outcomes.
 */
function classifyChapterBody(body: string, requestedAsin: string): ChapterRuntimeOutcome {
  if (body.trim().length === 0) return { kind: 'invalid_record', reason: 'empty-body' };

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { kind: 'invalid_record', reason: 'non-json-body' };
  }

  const parsed = audnexusChaptersSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid_record', reason: 'schema-invalid' };
  if (parsed.data.asin !== requestedAsin) return { kind: 'invalid_record', reason: 'asin-mismatch' };
  if (!Array.isArray(parsed.data.chapters)) return { kind: 'invalid_record', reason: 'missing-chapters' };

  // Transport computes both runtimes; the service decides whether either is trustworthy.
  const trim = computeTrimmedChapterRuntime(parsed.data.chapters, parsed.data.runtimeLengthMs);
  return {
    kind: 'ok',
    runtimeLengthMs: parsed.data.runtimeLengthMs,
    isAccurate: parsed.data.isAccurate,
    trimmedRuntimeMs: trim.trimmedRuntimeMs,
    trimmedChapterCount: trim.trimmedChapterCount,
  };
}

function mapAuthor(d: AudnexusAuthorDetail): Record<string, unknown> {
  return {
    asin: d.asin ?? undefined,
    name: d.name ?? '',
    description: d.description ?? undefined,
    imageUrl: d.image || undefined,
    genres: normalizeGenres(d.genres?.map((g) => g.name).filter((n): n is string => Boolean(n))),
  };
}

function mapSeriesRef(
  ref: { name?: string | null | undefined; position?: string | null | undefined; asin?: string | null | undefined } | null | undefined,
): { name: string; position?: number; asin?: string } | undefined {
  if (!ref?.name) return undefined;
  const parsed = ref.position != null ? parseFloat(ref.position) : NaN;
  const position = Number.isFinite(parsed) ? parsed : undefined;
  return {
    name: ref.name,
    ...(position !== undefined && { position }),
    ...(ref.asin && { asin: ref.asin }),
  };
}

function mapSeriesRefs(
  d: AudnexusBookDetail,
): Array<{ name: string; position?: number; asin?: string }> | undefined {
  const out: Array<{ name: string; position?: number; asin?: string }> = [];
  for (const ref of [d.seriesPrimary, d.seriesSecondary]) {
    const mapped = mapSeriesRef(ref);
    if (mapped) out.push(mapped);
  }
  return out.length > 0 ? out : undefined;
}

function mapBookAuthors(d: AudnexusBookDetail): Array<{ name: string; asin?: string }> {
  return (d.authors ?? []).map((a) => ({
    name: a.name ?? '',
    ...(a.asin && { asin: a.asin }),
  }));
}

function mapBook(d: AudnexusBookDetail): Record<string, unknown> {
  return {
    asin: d.asin ?? undefined,
    isbn: d.isbn ?? undefined,
    title: d.title ?? '',
    subtitle: d.subtitle ?? undefined,
    authors: mapBookAuthors(d),
    narrators: d.narrators?.map((n) => n.name).filter((n): n is string => Boolean(n)),
    series: mapSeriesRefs(d),
    seriesPrimary: mapSeriesRef(d.seriesPrimary),
    description: d.summary || d.description || undefined,
    publisher: d.publisherName ?? undefined,
    publishedDate: d.releaseDate ?? undefined,
    language: d.language ?? undefined,
    coverUrl: d.image || undefined,
    duration: d.runtimeLengthMin ?? undefined,
    genres: normalizeGenres(d.genres?.map((g) => g.name).filter((n): n is string => Boolean(n))),
  };
}
