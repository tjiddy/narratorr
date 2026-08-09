import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { DbOrTx } from '@db/index.js';
import { authors, bookAuthors, books, series, seriesMembers } from '@db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { generatePublicId } from '../utils/public-id.js';
import { normalizeMemberTitleForMatch } from './series-title-match.js';
import { serializeError } from '../utils/serialize-error.js';
import { parseClearedFields, serializeClearedFields } from '../utils/cleared-fields.js';

// Provider IDs belong to GET-time Hardcover resolution; these writes create local placeholders.
export interface ReplaceSeriesLinkArgs {
  name: string;
  position: number | null;
  title: string;
  authorName: string | null;
}

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
 * Delete local rows, but preserve canonical Hardcover rows by clearing only their book link.
 * keepLinkedSeriesId retains the target's provider link during rematches.
 */
async function detachBookRows(tx: DbOrTx, bookId: number, keepLinkedSeriesId: number | null): Promise<void> {
  await tx
    .delete(seriesMembers)
    .where(and(eq(seriesMembers.bookId, bookId), eq(seriesMembers.source, 'local')));
  await tx
    .update(seriesMembers)
    .set({ bookId: null, updatedAt: new Date() })
    .where(keepLinkedSeriesId === null
      ? eq(seriesMembers.bookId, bookId)
      : and(eq(seriesMembers.bookId, bookId), ne(seriesMembers.seriesId, keepLinkedSeriesId)));
}

/**
 * Never seed a local row into a Hardcover-canonical series: it would duplicate its canonical match.
 * Card reconciliation handles genuinely unclaimed books.
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

export interface UnclaimedLibraryBook {
  id: number;
  title: string;
  seriesPosition: number | null;
}

// Batch load; authorId breaks legacy/default position ties deterministically.
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
 * Seed owned books not claimed by any member; Hardcover may exclude dateless planned works.
 * Non-null bookId activates the local partial unique index.
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

export async function detachBookFromSeriesMembers(tx: DbOrTx, bookId: number): Promise<void> {
  await detachBookRows(tx, bookId, null);
}

/**
 * Target members are rebuilt before this call; remove prior memberships and empty old series only.
 * Do not seed a local target row because Hardcover membership owns it.
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

// Create-time cache seeding is best-effort; later card resolution can replace it.
export async function upsertSeriesLink(
  tx: DbOrTx,
  log: FastifyBaseLogger,
  bookId: number,
  args: ReplaceSeriesLinkArgs,
): Promise<void> {
  try {
    const normalized = normalizeSeriesName(args.name);
    const seriesId = await resolveSeriesId(tx, args.name, normalized);

    // A local row would duplicate a canonical match; card reconciliation seeds unclaimed books.
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

// Read after the remote fetch, inside the transaction, or a stale snapshot can erase other clears.
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

// Batch after the remote fetch inside the transaction, avoiding stale clears and N serialized reads.
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
