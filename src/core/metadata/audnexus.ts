import { z } from 'zod';
import { BookMetadataSchema, AuthorMetadataSchema } from './schemas.js';
import { MetadataError, RateLimitError, TransientError } from './errors.js';
import { normalizeGenres } from './genres.js';
import { computeTrimmedChapterRuntime } from './chapter-trim.js';
// All three 429 arms (chapters, book, author) route through the shared normalizer —
// no path may hand the service a window it cannot honor. See retry-after.ts (#1944).
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

/**
 * A single chapter entry (#2168). Read for `title` and `lengthMs` so the trailing
 * promotional run can be trimmed off the published total; every field is
 * `.nullish()` and the object `.passthrough()` per the external-API convention.
 *
 * The `.catch({})` is load-bearing, NOT a convenience: parsing entries must never
 * narrow the record predicate below. A bare-string entry, a numeric entry, or one
 * whose `lengthMs` is a string is a malformed ENTRY — it degrades the trim (the
 * walk stops on it) but the body is still the requested edition's chapter record.
 * Without the fallback such a body would become `invalid_record`, which is
 * transient, never cached, and would re-request forever.
 */
const audnexusChapterEntrySchema = z.object({
  title: z.string().nullish(),
  lengthMs: z.number().nullish(),
}).passthrough().catch({});

/**
 * Chapter-endpoint raw schema (#1942, #2168). The endpoint publishes its own
 * `runtimeLengthMs`, which stays the primary reference — the entries are parsed
 * only to compute the TRIMMED second reference (`computeTrimmedChapterRuntime`),
 * never to re-sum the total. `runtimeLengthMs`/`isAccurate` are `.nullish()`
 * (external-API convention) so a GENUINE record with a null trust field still
 * validates and settles as a definitive trust-fail; the identity + shape predicate
 * below — not these fields — is what proves authority.
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

  /**
   * Typed lookup that never throws — every failure becomes a discriminated kind.
   * See `MetadataSearchProvider.getBookDetailed` for the wrapper-contract.
   */
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
   * Edition chapter-runtime lookup (#1942) — `GET /books/{asin}/chapters`, region
   * forwarded exactly as the book/author lookups do (the endpoint defaults to `us`,
   * so a bare path would silently answer with US chapters for a non-US edition).
   *
   * Deliberately does NOT reuse `fetchJsonDetailed`: that helper collapses three
   * distinctions this feature's cache depends on (see {@link ChapterRuntimeOutcome}).
   *   - It maps every non-OK status to `not_found`, which would settle a temporary
   *     401/403/408 as a permanent "no runtime" for the service lifetime.
   *   - It branches on `response.ok`, true for all of 200–299, so a null-body
   *     202/204 would enter the record parser.
   *   - It folds every `response.json()` rejection into `transient_failure`, which
   *     conflates a body-stream abort (the exchange never completed) with a
   *     completed-but-unparseable body.
   *
   * Never throws; owns no cache and no throttle.
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
      // Pre-header rejection — network/DNS/TLS/timeout, and the 3xx redirect that
      // `fetchWithTimeout` throws rather than returning.
      return { kind: 'transient_failure', message: getErrorMessage(error) };
    }

    if (response.status === 429) {
      return { kind: 'rate_limited', retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')) };
    }
    // The ONLY statuses Audnexus documents as "this ASIN is absent/invalid".
    if (response.status === 400 || response.status === 404) return { kind: 'not_found' };
    // Exact-200 gate, not `response.ok`.
    if (response.status !== 200) {
      return { kind: 'transient_failure', message: `HTTP ${response.status} ${response.statusText}` };
    }

    // Split at the body boundary: `fetchWithTimeout` returns the Response with its
    // timeout signal still attached, so the stream can reject AFTER headers.
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

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/**
 * The authority predicate (#1942, F18/F20). A fully-read 200 is NOT an
 * authoritative statement about an edition just because its bytes arrived — this
 * boundary routinely sees HTML interstitials, rate-limit pages, and upstream shape
 * changes. A body is the requested edition's COMPLETE chapter record only when
 * BOTH hold:
 *
 *  1. **Identity** — `asin` strictly equals the requested ASIN, and
 *  2. **Shape** — a `chapters` array is present.
 *
 * The AND is load-bearing. An OR would admit a wrong-`asin` chapter record (another
 * edition, whose runtime could falsely clear a genuine mismatch) and an ASIN-only
 * error envelope (`{ asin, message: 'temporarily unavailable' }`, which would settle
 * as a permanent trust-fail). Both are `invalid_record` → transient → never cached.
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

  // #2168 — the trailing-trim rule rides on the same authoritative record. It is
  // pure arithmetic over what was parsed; the trust gate that turns EITHER runtime
  // into a usable reference is the service's, not the transport's.
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
