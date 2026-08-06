import type { seriesMembers } from '@db/schema.js';
import { findInLibraryMatch, type LibraryBookSummary } from './series-title-match.js';

/**
 * How a series card's member entries are ASSEMBLED and ORDERED from a stored
 * member set plus the library pool — the pure half of `SeriesCardService`, with
 * no DB handle, no Hardcover client, and no transaction of its own.
 *
 * It lives apart from the service because the two answer different questions and
 * change for different reasons: the service decides when to fetch, persist and
 * reconcile; this module decides what the operator sees and which owned books
 * still lack a row. Keeping the rule in one place is what lets the render path,
 * the rebuild's seed and the reconcile's guard all derive their answer from the
 * same computation instead of three that can drift (#2144).
 */

export interface BookSeriesMemberCard {
  hardcoverBookId: number | null;
  slug: string | null;
  title: string;
  position: number | null;
  imageUrl: string | null;
  inLibrary: boolean;
  libraryBookId: number | null;
}

export type SeriesMemberRow = typeof seriesMembers.$inferSelect;

/** The card's two inputs, always read together off one handle. */
export interface MemberState {
  rows: SeriesMemberRow[];
  pool: LibraryBookSummary[];
}

/** What one partition/match pass over a {@link MemberState} yields. */
export interface BuiltMembers {
  /** The card's entries, in {@link compareByPositionThenTitle} order. */
  members: BookSeriesMemberCard[];
  /** Pool books no member row claims — what a seed would have to write. */
  unclaimed: LibraryBookSummary[];
}

/**
 * Member ordering shared by the cache-driven and library-only paths: numeric
 * `series_position` ascending with NULL positions placed at the end. `title`
 * is the tie-breaker for stable order. SQLite's default ASC puts NULLs FIRST,
 * which is why the cache path can't lean on the DB's ORDER BY for parity.
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

/** The owned-book entry shape: rendered from the BOOK, never from a stored row. */
export function libraryMemberCard(book: LibraryBookSummary): BookSeriesMemberCard {
  return {
    hardcoverBookId: null,
    slug: null,
    title: book.title,
    position: book.seriesPosition,
    imageUrl: null,
    inLibrary: true,
    libraryBookId: book.id,
  };
}

/**
 * ONE partition/match pass over a member set + its library pool — written once
 * and applied to the snapshot rows, to the reconcile transaction's returned rows,
 * and (through `unclaimed`) to the seed decision, so what the card shows and what
 * the DB stores are computed by the same rule (#2144).
 *
 * The order of the three phases is the contract:
 *
 *   1. **Local rows claim by `book_id`, BEFORE the matcher runs.** A local row is
 *      a durable statement that THIS book is a member, so it resolves through the
 *      pool by id and can never claim a different one — and, claiming first, no
 *      Hardcover member can take the book out from under it. A row whose `book_id`
 *      is NULL (the book was deleted; the FK is `ON DELETE SET NULL`) or whose
 *      book is no longer in the pool (its `books.series_name` moved) resolves to
 *      nothing and is DROPPED — residue renders as no entry at all, never as a
 *      phantom "+ Add".
 *   2. **Hardcover rows match by title/position** against the pool, minus what
 *      step 1 claimed, through the shared `findInLibraryMatch` + claim set. Local
 *      rows never enter the title matcher, or one could claim a sibling's book.
 *   3. **Every pool book not claimed by a Hardcover member gets its own entry**,
 *      rendered from the book's CURRENT title and `series_position` — so a local
 *      row whose stored title has since drifted does not render stale text, and
 *      position `0` stays `0` rather than coercing to null. Of those, the ones no
 *      local row claimed either are the `unclaimed` set: books with no row at all.
 *
 * Entries are interleaved by `compareByPositionThenTitle`, not appended as an
 * "extras" block, so an owned book sorts into its position among the canonical
 * members. This NARROWS the #1139 no-inflation rule rather than deleting it: the
 * card still never gains an entry that is neither a canonical member nor a book
 * in the pool.
 */
export function buildMembersFromState({ rows, pool }: MemberState): BuiltMembers {
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
    members.push({
      hardcoverBookId: row.hardcoverBookId,
      slug: row.slug,
      title: row.title,
      position: row.position,
      imageUrl: row.imageUrl,
      inLibrary: match !== null,
      libraryBookId: match?.id ?? null,
    });
  }

  const unclaimed: LibraryBookSummary[] = [];
  for (const book of pool) {
    if (claimed.has(book.id) && !claimedByLocal.has(book.id)) continue;
    if (!claimedByLocal.has(book.id)) unclaimed.push(book);
    members.push(libraryMemberCard(book));
  }

  return { members: members.sort(compareLibraryMembers), unclaimed };
}
