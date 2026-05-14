import type { BookMetadata, BookWithAuthor, BookIdentifier, CreateBookPayload } from '@/lib/api';

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
    description: book.description,
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

export function isBookInLibrary(book: BookMetadata, libraryBooks?: LibraryEntry[]): boolean {
  if (!libraryBooks?.length) return false;
  return libraryBooks.some((lb) => {
    if (book.asin && lb.asin && book.asin === lb.asin) return true;
    const titleMatch = lb.title.toLowerCase() === book.title.toLowerCase();
    const authorName = getAuthorName(lb);
    const bookAuthorName = book.authors[0]?.name;

    // Both sides have no author — match by title only
    if (!bookAuthorName && !authorName) return titleMatch;

    // One side has author, the other doesn't — not a match
    if (!bookAuthorName || !authorName) return false;

    return titleMatch && authorName.toLowerCase() === bookAuthorName.toLowerCase();
  });
}
