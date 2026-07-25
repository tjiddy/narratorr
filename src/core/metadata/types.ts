import type { z, ZodIssue } from 'zod';
import type {
  BookMetadataSchema,
  AuthorMetadataSchema,
  SeriesMetadataSchema,
  MetadataSearchResultsSchema,
} from './schemas.js';

export type BookMetadata = z.infer<typeof BookMetadataSchema>;
export type AuthorMetadata = z.infer<typeof AuthorMetadataSchema>;
export type SeriesMetadata = z.infer<typeof SeriesMetadataSchema>;
export type MetadataSearchResults = z.infer<typeof MetadataSearchResultsSchema>;

export interface SearchBooksOptions {
  maxResults?: number;
  /** When provided, search by structured title instead of raw keywords. */
  title?: string;
  /** When provided alongside title, search by structured author. */
  author?: string;
}

export interface SearchBooksResult {
  books: BookMetadata[];
  rawCount?: number;
}

/**
 * Typed outcome union for `getBookDetailed`. Distinguishes raw-schema failures
 * (HTML interstitial / API shape change) from mapped-schema failures (record
 * missing a required field) so the Fix Match route can preserve the existing
 * `getBook` throw/null contract while still routing 422 for both cases.
 */
export type ProviderLookupResult =
  | { kind: 'ok'; book: BookMetadata }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'invalid_record'; source: 'mapped' | 'raw'; cause?: unknown; issues?: ZodIssue[] }
  | { kind: 'transient_failure'; message: string };

/**
 * Typed outcome union for the chapter-runtime lookup (#1942). The chapter table
 * is a strictly more authoritative runtime than the `runtimeLengthMin` scalar,
 * so the owner caches a derived verdict from it — which makes the *classification*
 * load-bearing, not just the payload:
 *
 * - **Definitive** (safe to cache): `ok` — and ONLY when the 200 body is the
 *   requested edition's COMPLETE chapter record (`asin` strictly equal to the
 *   requested ASIN AND a present `chapters` array) — plus `not_found`, emitted
 *   for the documented HTTP 400/404 only.
 * - **Transient** (never cached; a later call may succeed): everything else —
 *   `invalid_record` for a 200 that fails the record predicate (empty, non-JSON,
 *   JSON primitive, schema-invalid, fieldless/error envelope, wrong-`asin`, or no
 *   chapter array), `rate_limited` for a 429, and `transient_failure` for a
 *   pre-header fetch rejection (incl. the 3xx redirect throw), a post-header body
 *   read/abort/decode failure, any 5xx, and any other non-success or non-200 2xx
 *   status.
 *
 * `runtimeLengthMs`/`isAccurate` ride raw and nullable: the trust gate that turns
 * them into a usable runtime belongs to the service, not the transport.
 */
export type ChapterRuntimeOutcome =
  | { kind: 'ok'; runtimeLengthMs: number | null | undefined; isAccurate: boolean | null | undefined }
  | { kind: 'not_found' }
  | { kind: 'invalid_record'; reason: string }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'transient_failure'; message: string };

/** Shared fields for all metadata providers. */
export interface MetadataProviderBase {
  readonly name: string;
  readonly type: string;
}

/** Search provider — catalog search, book/series detail, connectivity test. */
export interface MetadataSearchProvider extends MetadataProviderBase {
  searchBooks(query: string, options?: SearchBooksOptions): Promise<SearchBooksResult>;
  searchSeries(query: string): Promise<SeriesMetadata[]>;
  getBook(id: string): Promise<BookMetadata | null>;
  getBookDetailed(id: string): Promise<ProviderLookupResult>;
  test(): Promise<{ success: boolean; message?: string }>;
}

/** Enrichment provider — book enrichment data and author detail lookups. */
export interface MetadataEnrichmentProvider extends MetadataProviderBase {
  getBook(id: string): Promise<BookMetadata | null>;
  getBookDetailed(id: string): Promise<ProviderLookupResult>;
  getAuthor(id: string): Promise<AuthorMetadata | null>;
  /**
   * Edition chapter-runtime lookup (#1942) — never throws; owns no cache and no
   * throttling (both belong to the calling service). See {@link ChapterRuntimeOutcome}.
   */
  getChapterRuntime(id: string): Promise<ChapterRuntimeOutcome>;
}
