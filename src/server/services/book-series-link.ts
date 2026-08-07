import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { DbOrTx } from '@db/index.js';
import { authors, bookAuthors, books, series, seriesMembers } from '@db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { generatePublicId } from '../utils/public-id.js';
import { normalizeMemberTitleForMatch } from './series-title-match.js';
import { serializeError } from '../utils/serialize-error.js';
import { parseClearedFields, serializeClearedFields } from '../utils/cleared-fields.js';

/**
 * Slim payload for linking a freshly-created or rematched book to its series.
 * No provider columns: the Hardcover lazy-populate flow at GET time owns
 * `hardcover_series_id` / `hardcover_book_id` / `image_url` / `slug`. Local
 * inserts here are placeholders that the next series-card GET replaces with
 * the canonical Hardcover member set when a Hardcover key is configured.
 */
export interface ReplaceSeriesLinkArgs {
  name: string;
  position: number | null;
  title: string;
  authorName: string | null;
}

/**
 * Resolve (or create) the canonical `series` row for the provided args by
 * normalized name. Never writes a Hardcover id — that's the resolver's job
 * on the next GET. Returns the resolved series id.
 */
async function resolveSeriesId(tx: DbOrTx, name: string, normalized: string): Promise<number> {
  const found = await tx
    .select({ id: series.id })
    .from(series)
    .where(eq(series.normalizedName, normalized))
    .limit(1);
  if (found.length > 0) return found[0]!.id;
  const inserted = await tx
    .insert(series)
    .values({ publicId: generatePublicId('sr'), name, normalizedName: normalized })
    .returning({ id: series.id });
  return inserted[0]!.id;
}

/**
 * Detach a book from its `series_members` rows, source by source (#2069 AC14,
 * #2150). THE single definition of what "this book is no longer that row's
 * book" means, shared by the Edit-Metadata clear and by Fix Match:
 *
 *   - `source: 'local'` rows are the book's own cache seed. Nothing else
 *     references them and a book-less local row is residue the card renders as
 *     nothing, so they are DELETED — in every series, `keepLinkedSeriesId`
 *     included.
 *   - `source: 'hardcover'` rows are canonical members that still belong on
 *     their series card, so they keep their identity and only lose the book link
 *     (`book_id = NULL`, `updated_at` bumped). `buildCardFromCache` computes a
 *     Hardcover row's `inLibrary` by title-matching against books selected on
 *     `books.series_name`, never off `series_members.book_id`, so the sibling
 *     card is unaffected.
 *
 * `keepLinkedSeriesId` exempts ONE series' provider rows from the null-link:
 * Fix Match passes its resolved target so a member already pointing at this book
 * — the "same series, corrected position" case — is not needlessly degraded.
 * `null` means no exemption.
 */
async function detachBookRows(tx: DbOrTx, bookId: number, keepLinkedSeriesId: number | null): Promise<void> {
  await tx
    .delete(seriesMembers)
    .where(and(eq(seriesMembers.bookId, bookId), eq(seriesMembers.source, 'local')));
  // Everything still linked to the book after that delete is provider-sourced.
  await tx
    .update(seriesMembers)
    .set({ bookId: null, updatedAt: new Date() })
    .where(keepLinkedSeriesId === null
      ? eq(seriesMembers.bookId, bookId)
      : and(eq(seriesMembers.bookId, bookId), ne(seriesMembers.seriesId, keepLinkedSeriesId)));
}

/**
 * Replace series membership for a book rematched via Fix Match. Clears the
 * book's own local rows everywhere and unlinks its provider rows outside the new
 * target (`detachBookRows`); inserts one fresh local row only when `args` names a
 * target that is NOT Hardcover-canonical. Errors propagate — caller's
 * transaction rolls back.
 *
 * The canonical guard is the same one `upsertSeriesLink` applies, and for the
 * same reason (#2150): since #2144 a `source: 'local'` row claims its book BEFORE
 * the title matcher runs (`series-card-members.ts`), so a local row seeded into a
 * Hardcover-canonical series takes the book away from its canonical member — the
 * member renders '+ Add' while the book renders as a second owned entry. A book
 * the canonical member set does NOT contain is still covered: the card build's
 * reconcile seeds its local row, which unlike this call site can see the whole
 * member set and therefore knows the book was left unclaimed.
 *
 * `resolveSeriesId` runs FIRST — before any delete — because the null-link's
 * exemption and the canonical branch both key on the resolved target id.
 */
export async function replaceSeriesLink(
  tx: DbOrTx,
  bookId: number,
  args: ReplaceSeriesLinkArgs | null,
): Promise<void> {
  const seriesId = args ? await resolveSeriesId(tx, args.name, normalizeSeriesName(args.name)) : null;
  await detachBookRows(tx, bookId, seriesId);
  if (!args || seriesId === null) return;

  const seriesRow = await tx
    .select({ hardcoverSeriesId: series.hardcoverSeriesId })
    .from(series)
    .where(eq(series.id, seriesId))
    .limit(1);
  if (seriesRow[0]?.hardcoverSeriesId != null) return;

  await tx.insert(seriesMembers).values({
    seriesId,
    bookId,
    title: args.title,
    normalizedTitle: normalizeMemberTitleForMatch(args.title),
    authorName: args.authorName,
    position: args.position,
    source: 'local',
  });
}

/**
 * A library book in a series' card pool — the shape the local-row seed reads.
 * Structurally identical to `LibraryBookSummary`, and deliberately declared here
 * rather than imported: `LibraryBookSummary` is the TITLE MATCHER's input type,
 * shared with `findInLibraryMatch` and the blast-check replay, so binding the
 * seed to it would make any future widening of the matcher's input ripple in.
 */
export interface UnclaimedLibraryBook {
  id: number;
  title: string;
  seriesPosition: number | null;
}

/**
 * The BOOK's primary author for each of `bookIds` — `authors.name` of the
 * `book_authors` row with the lowest `position`, tie-broken by the lowest
 * `author_id`, and absent from the map when the book has no author link.
 *
 * ONE query for the whole batch, never one per book: the seed runs inside the
 * caller's transaction, and a per-book lookup would hold it open across N round
 * trips. `book_authors.position` is `NOT NULL DEFAULT 0`, so defaulted, legacy
 * or hand-seeded rows can tie there — hence the `author_id` tie-break, which
 * makes the pick deterministic rather than plan-dependent. (The production
 * writer assigns sequential positions, so a tie is the anomalous shape, not the
 * usual co-author one.)
 */
async function loadPrimaryAuthorNames(tx: DbOrTx, bookIds: number[]): Promise<Map<number, string>> {
  const rows = await tx
    .select({ bookId: bookAuthors.bookId, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
    .where(inArray(bookAuthors.bookId, bookIds))
    .orderBy(asc(bookAuthors.bookId), asc(bookAuthors.position), asc(bookAuthors.authorId));
  const primary = new Map<number, string>();
  for (const row of rows) {
    if (!primary.has(row.bookId)) primary.set(row.bookId, row.name);
  }
  return primary;
}

/**
 * Seed one `source: 'local'` member row per owned book that no `series_members`
 * row claims (#2144). THE single definition of what such a row looks like, called
 * from both sites that can observe an unclaimed book — `persistMembers`' rebuild
 * and the card build's reconcile transaction — so display and persistence cannot
 * diverge. Runs on the caller's handle; errors propagate.
 *
 * The invariant it upholds: a library book carrying a series name appears on that
 * series' member list regardless of what Hardcover thinks. Hardcover's member
 * queries exclude dateless works (`release_date: {_is_null: false, _lt: $today}`,
 * which correctly keeps unreleased books off the card), so an owned book whose
 * Hardcover entry is a "Planned book" stub pairs with nothing — and
 * `upsertSeriesLink`'s canonical-series guard deliberately seeds nothing either.
 *
 * Each row carries `hardcover_book_id IS NULL`, so it is constrained by
 * `idx_series_members_local_unique (series_id, book_id)` — one row per book per
 * series. `bookId` is always non-null here, which is what makes that partial
 * index bite ([[sqlite-null-unique-index]]); a local row that LATER loses its
 * book to `ON DELETE SET NULL` is residue, not a member, and the card drops it.
 * `authorName` is the BOOK's own primary author, matching the create-time
 * precedent in `BookService.runResolvedInsert`, not the series author.
 */
export async function seedLocalMembersForUnclaimedBooks(
  tx: DbOrTx,
  seriesId: number,
  unclaimed: readonly UnclaimedLibraryBook[],
): Promise<void> {
  if (unclaimed.length === 0) return;
  const authorNames = await loadPrimaryAuthorNames(tx, unclaimed.map((b) => b.id));
  for (const book of unclaimed) {
    await tx.insert(seriesMembers).values({
      seriesId,
      bookId: book.id,
      hardcoverBookId: null,
      slug: null,
      imageUrl: null,
      title: book.title,
      normalizedTitle: normalizeMemberTitleForMatch(book.title),
      authorName: authorNames.get(book.id) ?? null,
      position: book.seriesPosition,
      source: 'local',
    });
  }
}

/**
 * Reconcile a book's `series_members` rows after the operator explicitly CLEARED
 * its series through Edit Metadata (#2069 AC14). Runs on the caller's handle,
 * inside the same transaction as the clear, so a failure here rolls the clear
 * back rather than leaving exactly the stale residue this removes.
 *
 * A total detach — no series survives the clear, so nothing is exempted from the
 * null-link. `replaceSeriesLink` shares the same source-by-source rule through
 * `detachBookRows` (#2150) and differs only in exempting its new target; see that
 * helper's docblock for why local rows are deleted and provider rows are not.
 */
export async function detachBookFromSeriesMembers(tx: DbOrTx, bookId: number): Promise<void> {
  await detachBookRows(tx, bookId, null);
}

/**
 * Re-link a book onto a Hardcover-canonical `series` row during a manual
 * series bind (#1228). Runs inside the caller's transaction; errors propagate
 * so the bind participates in the atomic rollback.
 *
 * The caller has already (a) updated `books.series_name` to the canonical
 * Hardcover name and (b) rebuilt the target series' Hardcover member set,
 * which pairs this book to its Hardcover member from the `books` table when it
 * is a member. This helper handles the *cleanup* the member rebuild does not:
 *
 *   - Deletes the book's prior `series_members` rows that belong to OTHER
 *     series rows (the rebuild already replaced the target series' rows).
 *   - Deletes any of those now-empty old `series` rows so no orphan is left.
 *
 * It deliberately does NOT insert a local member: the target is
 * Hardcover-canonical (`hardcover_series_id` set), so seeding a local row would
 * duplicate the Hardcover match — the same guard `upsertSeriesLink` applies at
 * `hardcover_series_id != null`.
 */
export async function relinkBookToBoundSeries(
  tx: DbOrTx,
  bookId: number,
  targetSeriesId: number,
): Promise<void> {
  const prior = await tx
    .select({ seriesId: seriesMembers.seriesId })
    .from(seriesMembers)
    .where(and(eq(seriesMembers.bookId, bookId), ne(seriesMembers.seriesId, targetSeriesId)));
  const oldSeriesIds = [...new Set(prior.map((r) => r.seriesId))];

  await tx
    .delete(seriesMembers)
    .where(and(eq(seriesMembers.bookId, bookId), ne(seriesMembers.seriesId, targetSeriesId)));

  for (const seriesId of oldSeriesIds) {
    const remaining = await tx
      .select({ id: seriesMembers.id })
      .from(seriesMembers)
      .where(eq(seriesMembers.seriesId, seriesId))
      .limit(1);
    if (remaining.length === 0) {
      await tx.delete(series).where(eq(series.id, seriesId));
    }
  }
}

/**
 * Upsert the (series + local series_member) cache rows for a freshly-created
 * book when the create payload carries a series name. Best-effort: failures
 * are caught + logged so book create stays the success path. The next
 * series-card GET with a Hardcover key configured will see this as a cache
 * miss (`hardcover_series_id IS NULL`) and replace the local member set with
 * the Hardcover-resolved rows.
 */
export async function upsertSeriesLink(
  tx: DbOrTx,
  log: FastifyBaseLogger,
  bookId: number,
  args: ReplaceSeriesLinkArgs,
): Promise<void> {
  try {
    const normalized = normalizeSeriesName(args.name);
    const seriesId = await resolveSeriesId(tx, args.name, normalized);

    // When the series is already Hardcover-canonical, skip the local-row seed:
    // the next series-card GET's `findInLibraryMatch` will pair this book with
    // its Hardcover member directly from the `books` table. Inserting a local
    // row here would coexist with that match (both pass the partial unique
    // indexes) and surface as two rows for the same book on the card.
    //
    // What this guard skips is COVERED, not lost (#2144): a book that pairs with
    // no Hardcover member gets its local row from the card build's reconcile —
    // which, unlike this call site, can see the whole member set and therefore
    // knows the book was left unclaimed. Keeping the decision there is what makes
    // "seeded" and "unpaired" the same verdict instead of two guesses.
    const seriesRow = await tx
      .select({ hardcoverSeriesId: series.hardcoverSeriesId })
      .from(series)
      .where(eq(series.id, seriesId))
      .limit(1);
    if (seriesRow[0]?.hardcoverSeriesId != null) return;

    const existing = await tx
      .select({ id: seriesMembers.id })
      .from(seriesMembers)
      .where(and(
        eq(seriesMembers.seriesId, seriesId),
        eq(seriesMembers.bookId, bookId),
        isNull(seriesMembers.hardcoverBookId),
      ))
      .limit(1);
    if (existing.length > 0) {
      await tx
        .update(seriesMembers)
        .set({
          title: args.title,
          normalizedTitle: normalizeMemberTitleForMatch(args.title),
          authorName: args.authorName,
          position: args.position,
          source: 'local',
          updatedAt: new Date(),
        })
        .where(eq(seriesMembers.id, existing[0]!.id));
      return;
    }
    await tx.insert(seriesMembers).values({
      seriesId,
      bookId,
      title: args.title,
      normalizedTitle: normalizeMemberTitleForMatch(args.title),
      authorName: args.authorName,
      position: args.position,
      source: 'local',
    });
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId, seriesName: args.name }, 'Series link upsert failed during book create');
  }
}

/**
 * Read the book's tombstone set ON the supplied handle and return the canonical
 * serialization with the `seriesName` entry removed (#2069 AC24) — the operator
 * re-assertion a Hardcover series bind performs.
 *
 * Read → drop → validate → serialize, all inside the caller's transaction: the
 * bind's `fetchById` is a network round-trip, so a `PUT` can add an unrelated
 * tombstone while it is in flight and writing back a pre-fetch snapshot would
 * silently erase that concurrent clear. Only `seriesName` is dropped — binding
 * asserts nothing about the other clearable fields.
 */
export async function removeSeriesNameTombstone(
  tx: DbOrTx,
  log: FastifyBaseLogger,
  bookId: number,
): Promise<string | null> {
  const rows = await tx
    .select({ userClearedFields: books.userClearedFields })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  const current = parseClearedFields(rows[0]?.userClearedFields ?? null, log, bookId);
  return serializeClearedFields(current.filter((field) => field !== 'seriesName'));
}

/**
 * Which of `bookIds` carry a live `seriesPosition` tombstone (#2152 AC9) — the
 * books a Hardcover bind must not write a position over.
 *
 * ONE batched `IN (…)` select on the caller's handle, never one query per book:
 * a bind syncs the whole matched sibling set, and a single libSQL connection
 * serializes every transaction ([[libsql-transactions-serialized-at-the-connection]]),
 * so per-book reads inside the open transaction lengthen the window every other
 * writer queues behind. Read INSIDE the transaction for the same reason
 * `removeSeriesNameTombstone` is: the bind's `fetchById` is a network round-trip
 * and a `PUT` can land a position clear while it is in flight.
 */
export async function readPositionClearedBookIds(
  tx: DbOrTx,
  log: FastifyBaseLogger,
  bookIds: readonly number[],
): Promise<Set<number>> {
  if (bookIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: books.id, userClearedFields: books.userClearedFields })
    .from(books)
    .where(inArray(books.id, [...new Set(bookIds)]));
  const cleared = new Set<number>();
  for (const row of rows) {
    if (parseClearedFields(row.userClearedFields, log, row.id).includes('seriesPosition')) {
      cleared.add(row.id);
    }
  }
  return cleared;
}
