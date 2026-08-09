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

/** Raw and mapped validation failures stay distinct for the legacy getBook contract. */
export type ProviderLookupResult =
  | { kind: 'ok'; book: BookMetadata }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'invalid_record'; source: 'mapped' | 'raw'; cause?: unknown; issues?: ZodIssue[] }
  | { kind: 'transient_failure'; message: string };

/**
 * `ok` for an authoritative matching-edition record and documented 400/404 `not_found`
 * are cacheable; every other outcome is transient. Runtime and trust fields stay raw
 * for service validation, and the trimmed count is diagnostic only.
 */
export type ChapterRuntimeOutcome =
  | {
      kind: 'ok';
      runtimeLengthMs: number | null | undefined;
      isAccurate: boolean | null | undefined;
      trimmedRuntimeMs: number | undefined;
      trimmedChapterCount: number;
    }
  | { kind: 'not_found' }
  | { kind: 'invalid_record'; reason: string }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'transient_failure'; message: string };

export interface MetadataProviderBase {
  readonly name: string;
  readonly type: string;
}

export interface MetadataSearchProvider extends MetadataProviderBase {
  searchBooks(query: string, options?: SearchBooksOptions): Promise<SearchBooksResult>;
  searchSeries(query: string): Promise<SeriesMetadata[]>;
  getBook(id: string): Promise<BookMetadata | null>;
  getBookDetailed(id: string): Promise<ProviderLookupResult>;
  test(): Promise<{ success: boolean; message?: string }>;
}

export interface MetadataEnrichmentProvider extends MetadataProviderBase {
  getBook(id: string): Promise<BookMetadata | null>;
  getBookDetailed(id: string): Promise<ProviderLookupResult>;
  getAuthor(id: string): Promise<AuthorMetadata | null>;
  /** Never throws; the calling service owns caching and throttling. */
  getChapterRuntime(id: string): Promise<ChapterRuntimeOutcome>;
}
