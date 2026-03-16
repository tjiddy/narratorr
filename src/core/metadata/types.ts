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
}

export interface MetadataProvider {
  readonly name: string;
  readonly type: string;
  search(query: string): Promise<MetadataSearchResults>;
  searchBooks(query: string, options?: SearchBooksOptions): Promise<BookMetadata[]>;
  searchAuthors(query: string): Promise<AuthorMetadata[]>;
  searchSeries(query: string): Promise<SeriesMetadata[]>;
  getBook(id: string): Promise<BookMetadata | null>;
  getAuthor(id: string): Promise<AuthorMetadata | null>;
  getAuthorBooks(id: string): Promise<BookMetadata[]>;
  getSeries(id: string): Promise<SeriesMetadata | null>;
  test(): Promise<{ success: boolean; message?: string }>;
}
