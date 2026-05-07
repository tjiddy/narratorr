import type { z } from 'zod';
import type {
  BookMetadataSchema,
  AuthorMetadataSchema,
  SeriesMetadataSchema,
  MetadataSearchResultsSchema,
  AuthorRefSchema,
  SeriesRefSchema,
} from './schemas.js';

export type AuthorRef = z.infer<typeof AuthorRefSchema>;
export type SeriesRef = z.infer<typeof SeriesRefSchema>;
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
  test(): Promise<{ success: boolean; message?: string }>;
}

/** Enrichment provider — book enrichment data and author detail lookups. */
export interface MetadataEnrichmentProvider extends MetadataProviderBase {
  getBook(id: string): Promise<BookMetadata | null>;
  getAuthor(id: string): Promise<AuthorMetadata | null>;
}
