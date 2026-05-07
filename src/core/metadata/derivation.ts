import { AuthorMetadataSchema, SeriesMetadataSchema } from './schemas.js';
import type { BookMetadata, AuthorMetadata, SeriesMetadata } from './types.js';

// Name-keyed, first-occurrence-wins dedup with safeParse construction.
// Single source of truth for the author/series derivation contract — used by
// `AudibleProvider.searchAuthors/searchSeries` (catalog-search side) and
// `MetadataService.search()` (post-filter derivation, see #1020).
export function deriveAuthorsFromBooks(books: BookMetadata[]): AuthorMetadata[] {
  const authorMap = new Map<string, AuthorMetadata>();
  for (const book of books) {
    for (const authorRef of book.authors ?? []) {
      if (authorMap.has(authorRef.name)) continue;
      const parsed = AuthorMetadataSchema.safeParse({
        name: authorRef.name,
        asin: authorRef.asin,
      });
      if (parsed.success) authorMap.set(authorRef.name, parsed.data);
    }
  }
  return Array.from(authorMap.values());
}

export function deriveSeriesFromBooks(books: BookMetadata[]): SeriesMetadata[] {
  const seriesMap = new Map<string, SeriesMetadata>();
  for (const book of books) {
    for (const seriesRef of book.series ?? []) {
      if (seriesMap.has(seriesRef.name)) continue;
      const parsed = SeriesMetadataSchema.safeParse({
        name: seriesRef.name,
        asin: seriesRef.asin,
        books: [],
      });
      if (parsed.success) seriesMap.set(seriesRef.name, parsed.data);
    }
  }
  return Array.from(seriesMap.values());
}
