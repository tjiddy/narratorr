import type { BookMetadata, BookWithAuthor, BookIdentifier, CreateBookPayload } from '@/lib/api';
import { matchesLibraryIdentity } from '../../shared/dedup.js';

export function mapBookMetadataToPayload(
  book: BookMetadata,
  qualityDefaults?: { searchImmediately?: boolean },
): CreateBookPayload {
  // Prefer the canonical primary-series ref over `series[0]` (#1088 / #1097) —
  // `series[0]` on Audible can be a broader universe entry rather than the real series.
  const primary = book.seriesPrimary ?? book.series?.[0];
  return {
    title: book.title,
    authors: book.authors.map((a) => ({ name: a.name, ...(a.asin !== undefined && { asin: a.asin }) })),
    narrators: book.narrators,
    subtitle: book.subtitle,
    description: book.description,
    publisher: book.publisher,
    coverUrl: book.coverUrl,
    asin: book.asin,
    seriesName: primary?.name,
    seriesPosition: primary?.position,
    seriesAsin: primary?.asin,
    ...(primary?.asin !== undefined && { seriesProvider: 'audible' }),
    duration: book.duration,
    genres: book.genres,
    providerId: book.providerId,
    searchImmediately: qualityDefaults?.searchImmediately,
  };
}

type LibraryEntry = BookIdentifier | BookWithAuthor;

function getAuthorName(entry: LibraryEntry): string | null | undefined {
  if ('authorName' in entry) return entry.authorName;
  return (entry as BookWithAuthor).authors?.[0]?.name;
}

// Delegates to the single shared library-identity predicate (#1662 F7) so the
// search-result / series "In Library" badge agrees with the import + backend
// duplicate verdict: case-insensitive ASIN, then normalized title + author slug
// (colon-subtitle / parenthetical / case drift), then author-less exact title.
function matchesLibraryEntry(book: BookMetadata, lb: LibraryEntry): boolean {
  return matchesLibraryIdentity(
    {
      title: book.title,
      ...(book.asin !== undefined && { asin: book.asin }),
      ...(book.authors[0]?.name !== undefined && { authorName: book.authors[0]?.name }),
    },
    { title: lb.title, asin: lb.asin, authorName: getAuthorName(lb) ?? null },
  );
}

export function findLibraryMatch<T extends LibraryEntry>(
  book: BookMetadata,
  libraryBooks?: readonly T[],
): T | null {
  if (!libraryBooks?.length) return null;
  return libraryBooks.find((lb) => matchesLibraryEntry(book, lb)) ?? null;
}

export function isBookInLibrary(book: BookMetadata, libraryBooks?: LibraryEntry[]): boolean {
  return findLibraryMatch(book, libraryBooks) !== null;
}
