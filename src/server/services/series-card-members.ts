import type { seriesMembers } from '@db/schema.js';
import { bucketForStatus, type BookStatus, type LibraryFilterBucket } from '@shared/schemas/book.js';
import { findInLibraryMatch, type LibraryBookSummary } from './series-title-match.js';

/**
 * Pure member projection shared by snapshot rendering, reconciliation, and seed decisions.
 */

export interface BookSeriesMemberCard {
  hardcoverBookId: number | null;
  slug: string | null;
  title: string;
  position: number | null;
  imageUrl: string | null;
  inLibrary: boolean;
  libraryBookId: number | null;
  /** Non-null exactly when the member resolves to a library book. */
  libraryBucket: LibraryFilterBucket | null;
}

export type SeriesMemberRow = typeof seriesMembers.$inferSelect;

/**
 * The projection needs a status the matcher must not see. Widening here instead of in
 * LibraryBookSummary keeps `findInLibraryMatch`'s candidate contract narrow; PoolBook satisfies
 * this structurally, and the matcher still accepts the same pool by width.
 */
export interface MemberPoolBook extends LibraryBookSummary {
  status: BookStatus;
}

export interface MemberState {
  rows: SeriesMemberRow[];
  pool: MemberPoolBook[];
  /**
   * Position tombstones gate projection only, after matching, so claim behavior is unchanged.
   */
  positionClearedIds: ReadonlySet<number>;
}

export interface BuiltMembers {
  members: BookSeriesMemberCard[];
  /** Pool books no member row claims, used by seeding. */
  unclaimed: MemberPoolBook[];
}

/**
 * Sort numeric positions first and nulls last, then title for stability. SQLite's default null-first
 * ordering cannot provide parity.
 */
export function compareByPositionThenTitle(aPos: number | null, aTitle: string, bPos: number | null, bTitle: string): number {
  if (aPos === null && bPos === null) return aTitle.localeCompare(bTitle);
  if (aPos === null) return 1;
  if (bPos === null) return -1;
  if (aPos !== bPos) return aPos - bPos;
  return aTitle.localeCompare(bTitle);
}

export function compareLibraryMembers(a: BookSeriesMemberCard, b: BookSeriesMemberCard): number {
  return compareByPositionThenTitle(a.position, a.title, b.position, b.title);
}

/**
 * Apply a position tombstone only to the resolved library book after matching; unmatched canonical
 * rows retain their numbering.
 */
function hardcoverMemberCard(
  row: SeriesMemberRow,
  match: MemberPoolBook | null,
  positionClearedIds: ReadonlySet<number>,
): BookSeriesMemberCard {
  return {
    hardcoverBookId: row.hardcoverBookId,
    slug: row.slug,
    title: row.title,
    position: match && positionClearedIds.has(match.id) ? null : row.position,
    imageUrl: row.imageUrl,
    inLibrary: match !== null,
    libraryBookId: match?.id ?? null,
    libraryBucket: match ? bucketForStatus(match.status) : null,
  };
}

export function libraryMemberCard(book: MemberPoolBook): BookSeriesMemberCard {
  return {
    hardcoverBookId: null,
    slug: null,
    title: book.title,
    position: book.seriesPosition,
    imageUrl: null,
    inLibrary: true,
    libraryBookId: book.id,
    libraryBucket: bucketForStatus(book.status),
  };
}

/**
 * Local rows claim by id before Hardcover rows match title/position against the remaining pool.
 * Remaining books render from current library data and form the unclaimed seed set. Interleave all
 * entries by position/title; tombstones affect only the post-match projection.
 */
export function buildMembersFromState({ rows, pool, positionClearedIds }: MemberState): BuiltMembers {
  const sorted = [...rows].sort((a, b) =>
    compareByPositionThenTitle(a.position, a.title, b.position, b.title),
  );
  const booksById = new Map(pool.map((book) => [book.id, book]));

  const claimed = new Set<number>();
  const claimedByLocal = new Set<number>();
  for (const row of sorted) {
    if (row.source !== 'local' || row.bookId === null) continue;
    if (!booksById.has(row.bookId)) continue;
    claimed.add(row.bookId);
    claimedByLocal.add(row.bookId);
  }

  const members: BookSeriesMemberCard[] = [];
  for (const row of sorted) {
    if (row.source === 'local') continue;
    const match = findInLibraryMatch({ title: row.title, position: row.position }, pool, claimed);
    if (match) claimed.add(match.id);
    // The matcher returns one of `pool`, so this re-entry is total; it recovers the status the
    // narrow candidate summary deliberately hides.
    members.push(hardcoverMemberCard(row, match ? booksById.get(match.id) ?? null : null, positionClearedIds));
  }

  const unclaimed: MemberPoolBook[] = [];
  for (const book of pool) {
    if (claimed.has(book.id) && !claimedByLocal.has(book.id)) continue;
    if (!claimedByLocal.has(book.id)) unclaimed.push(book);
    members.push(libraryMemberCard(book));
  }

  return { members: members.sort(compareLibraryMembers), unclaimed };
}
