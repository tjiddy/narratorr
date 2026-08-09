import type { BookMetadata, BookWithAuthor, LibraryEntry, CreateBookPayload } from '@/lib/api';
import { matchesLibraryIdentity } from '@shared/dedup.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

export function mapBookMetadataToPayload(
  book: BookMetadata,
  qualityDefaults?: { searchImmediately?: boolean },
): CreateBookPayload {
  // Audible `series[0]` may be a broader universe; use the canonical primary series.
  const primary = pickPrimarySeries(book);
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
    duration: book.duration,
    genres: book.genres,
    providerId: book.providerId,
    searchImmediately: qualityDefaults?.searchImmediately,
  };
}

function getAuthorName(entry: LibraryEntry): string | null | undefined {
  if ('authorName' in entry) return entry.authorName;
  return (entry as BookWithAuthor).authors?.[0]?.name;
}

// Keep search badges aligned with the import and backend duplicate-identity rules.
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

/** Distinguishes exact recordings from title-related editions; `isBookInLibrary` collapses both. */
export type LibraryMatchKind = 'exact-asin' | 'title-identity';

export interface LibraryMatch<T extends LibraryEntry> {
  entry: T;
  kind: LibraryMatchKind;
}

export function findLibraryMatch<T extends LibraryEntry>(
  book: BookMetadata,
  libraryBooks?: readonly T[],
): LibraryMatch<T> | null {
  if (!libraryBooks?.length) return null;
  // Scan ASINs first so API order cannot let a title-related edition mask the exact recording.
  const candidateAsin = canonicalizeAsin(book.asin);
  if (candidateAsin) {
    const asinMatch = libraryBooks.find((lb) => canonicalizeAsin(lb.asin) === candidateAsin);
    if (asinMatch) return { entry: asinMatch, kind: 'exact-asin' };
  }
  const titleMatch = libraryBooks.find((lb) => matchesLibraryEntry(book, lb));
  return titleMatch ? { entry: titleMatch, kind: 'title-identity' } : null;
}

export function isBookInLibrary(book: BookMetadata, libraryBooks?: LibraryEntry[]): boolean {
  return findLibraryMatch(book, libraryBooks) !== null;
}
