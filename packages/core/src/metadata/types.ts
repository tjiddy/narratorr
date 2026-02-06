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

export interface MetadataProvider {
  readonly name: string;
  readonly type: string;
  search(query: string): Promise<MetadataSearchResults>;
  searchBooks(query: string): Promise<BookMetadata[]>;
  searchAuthors(query: string): Promise<AuthorMetadata[]>;
  searchSeries(query: string): Promise<SeriesMetadata[]>;
  getBook(asin: string): Promise<BookMetadata | null>;
  getAuthor(asin: string): Promise<AuthorMetadata | null>;
  getAuthorBooks(asin: string): Promise<BookMetadata[]>;
  getSeries(asin: string): Promise<SeriesMetadata | null>;
  test(): Promise<{ success: boolean; message?: string }>;
}
