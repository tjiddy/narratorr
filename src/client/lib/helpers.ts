import type { BookMetadata, BookWithAuthor, BookIdentifier, CreateBookPayload } from '@/lib/api';
import { matchesLibraryIdentity } from '../../shared/dedup.js';
// ES imports are file-scoped — `dedup.ts`'s private import does NOT re-export
// `canonicalizeAsin`, so pull it directly from the shared ASIN module (#1907).
import { canonicalizeAsin } from '../../shared/asin.js';
import { pickPrimarySeries } from '../../shared/pick-primary-series.js';

export function mapBookMetadataToPayload(
  book: BookMetadata,
  qualityDefaults?: { searchImmediately?: boolean },
): CreateBookPayload {
  // Prefer the canonical primary-series ref over `series[0]` (#1088 / #1097) —
  // `series[0]` on Audible can be a broader universe entry rather than the real series.
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

/**
 * How a library entry matched the candidate (#1907):
 *   - `exact-asin`   — both canonical ASINs are non-null and equal.
 *   - `title-identity` — a confirmed match came through the title+author /
 *     author-less title fallback with a differing or absent ASIN.
 *
 * Consumers that need edition-aware semantics (the Add-Book search card) branch
 * on this; the coarse `isBookInLibrary` wrapper collapses both to "in library".
 */
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
  // AC1a — exact-ASIN precedence must be order-independent. `/api/books` defaults
  // to created-at-descending, so a newer title-related edition can precede an
  // older exact-ASIN edition; a naive first-`Array.find` over the raw predicate
  // would then classify the owned recording as a related edition. Scan for the
  // exact-ASIN match first, and only fall through to the first title-identity hit.
  const candidateAsin = canonicalizeAsin(book.asin);
  if (candidateAsin) {
    const asinMatch = libraryBooks.find((lb) => canonicalizeAsin(lb.asin) === candidateAsin);
    if (asinMatch) return { entry: asinMatch, kind: 'exact-asin' };
  }
  // No exact-ASIN incumbent — any confirmed match now came through the title path.
  // `matchesLibraryIdentity` stays the single source of truth for *whether* there
  // is a match; the kind is a post-hoc classification that cannot disagree.
  const titleMatch = libraryBooks.find((lb) => matchesLibraryEntry(book, lb));
  return titleMatch ? { entry: titleMatch, kind: 'title-identity' } : null;
}

export function isBookInLibrary(book: BookMetadata, libraryBooks?: LibraryEntry[]): boolean {
  return findLibraryMatch(book, libraryBooks) !== null;
}
