import type { BookMetadata, BookWithAuthor, BookIdentifier, CreateBookPayload } from '@/lib/api';

export function formatDuration(minutes?: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function mapBookMetadataToPayload(
  book: BookMetadata,
  qualityDefaults?: { searchImmediately?: boolean; monitorForUpgrades?: boolean },
): CreateBookPayload {
  return {
    title: book.title,
    authors: book.authors.map((a) => ({ name: a.name, asin: a.asin })),
    narrators: book.narrators,
    description: book.description,
    coverUrl: book.coverUrl,
    asin: book.asin,
    seriesName: book.series?.[0]?.name,
    seriesPosition: book.series?.[0]?.position,
    duration: book.duration,
    genres: book.genres,
    providerId: book.providerId,
    monitorForUpgrades: qualityDefaults?.monitorForUpgrades,
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
