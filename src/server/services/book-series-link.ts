import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { DbOrTx } from '../../db/index.js';
import { series, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { normalizeMemberTitleForMatch } from './series-title-match.js';
import { serializeError } from '../utils/serialize-error.js';

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
    .values({ name, normalizedName: normalized })
    .returning({ id: series.id });
  return inserted[0]!.id;
}

/**
 * Replace series membership for a book rematched via Fix Match. Always
 * deletes any prior `series_members` row for the book; inserts exactly one
 * fresh local-source row when `args` is non-null. Errors propagate — caller's
 * transaction rolls back.
 */
export async function replaceSeriesLink(
  tx: DbOrTx,
  bookId: number,
  args: ReplaceSeriesLinkArgs | null,
): Promise<void> {
  await tx.delete(seriesMembers).where(eq(seriesMembers.bookId, bookId));
  if (!args) return;

  const normalized = normalizeSeriesName(args.name);
  const seriesId = await resolveSeriesId(tx, args.name, normalized);

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
