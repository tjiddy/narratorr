import type { BookMetadata, BookWithAuthor, CreateBookPayload } from '@/lib/api';

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
  const author = book.authors[0];
  return {
    title: book.title,
    authorName: author?.name,
    authorAsin: author?.asin,
    narrator: book.narrators?.join(', '),
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

export function isBookInLibrary(book: BookMetadata, libraryBooks?: BookWithAuthor[]): boolean {
  if (!libraryBooks?.length) return false;
  return libraryBooks.some((lb) => {
    if (book.asin && lb.asin && book.asin === lb.asin) return true;
    const titleMatch = lb.title.toLowerCase() === book.title.toLowerCase();
    const authorMatch = book.authors[0]?.name
      && lb.author?.name?.toLowerCase() === book.authors[0].name.toLowerCase();
    return titleMatch && authorMatch;
  });
}
