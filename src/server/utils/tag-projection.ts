/**
 * The one row→tag-metadata projection. Lives in utils/ rather than beside its first caller because
 * `import-steps.ts` needs it too and utils/ may not import service values (eslint.config.js).
 *
 * Strict on `authors`/`narrators`: `BookService.getById` always hydrates both arrays, so a row
 * without them is a stale test double and the throw is what surfaces it.
 */

/** A hydrated book row — `BookDetail` satisfies it structurally. */
export interface TagProjectionSource {
  title: string;
  authors: { name: string }[];
  narrators: { name: string }[];
  seriesName?: string | null | undefined;
  seriesPosition?: number | null | undefined;
  asin?: string | null | undefined;
  subtitle?: string | null | undefined;
  description?: string | null | undefined;
  publisher?: string | null | undefined;
  publishedDate?: string | null | undefined;
  genres?: string[] | null | undefined;
  coverUrl?: string | null | undefined;
}

export interface TagProjection {
  title: string;
  authorName: string | null;
  narrator: string | null;
  seriesName: string | null | undefined;
  seriesPosition: number | null | undefined;
  asin: string | null | undefined;
  subtitle: string | null | undefined;
  description: string | null | undefined;
  publisher: string | null | undefined;
  publishedDate: string | null | undefined;
  genres: string[] | null | undefined;
  coverUrl: string | null | undefined;
}

function joinNames(people: { name: string }[]): string | null {
  return people.length > 0 ? people.map(p => p.name).join(', ') : null;
}

export function buildTagProjection(book: TagProjectionSource): TagProjection {
  return {
    title: book.title,
    authorName: joinNames(book.authors),
    narrator: joinNames(book.narrators),
    seriesName: book.seriesName, seriesPosition: book.seriesPosition,
    asin: book.asin, subtitle: book.subtitle, description: book.description,
    publisher: book.publisher, publishedDate: book.publishedDate, genres: book.genres,
    coverUrl: book.coverUrl,
  };
}
