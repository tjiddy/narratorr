import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { DbOrTx } from '../../db/index.js';
import { series, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import {
  findMemberByLogicalIdentity,
  normalizePrimaryAuthor,
  normalizeSeriesMemberWorkTitle,
} from './series-refresh.helpers.js';
import { serializeError } from '../utils/serialize-error.js';

export interface ReplaceSeriesLinkArgs {
  name: string;
  position: number | null;
  asin: string | null;
  seriesAsin: string | null;
  provider: string;
  title: string;
  authorName: string | null;
}

/**
 * Resolve (or create) the canonical `series` row for the provided args.
 * Returns the resolved series id.
 */
async function resolveSeriesId(tx: DbOrTx, args: ReplaceSeriesLinkArgs, normalized: string): Promise<number> {
  if (args.seriesAsin) {
    const found = await tx
      .select({ id: series.id })
      .from(series)
      .where(and(eq(series.provider, args.provider), eq(series.providerSeriesId, args.seriesAsin)))
      .limit(1);
    if (found.length > 0) return found[0]!.id;
  }
  const foundByName = await tx
    .select({ id: series.id })
    .from(series)
    .where(and(eq(series.provider, args.provider), eq(series.normalizedName, normalized)))
    .limit(1);
  if (foundByName.length > 0) {
    if (args.seriesAsin) {
      await tx
        .update(series)
        .set({ providerSeriesId: args.seriesAsin, updatedAt: new Date() })
        .where(and(eq(series.id, foundByName[0]!.id), sql`provider_series_id IS NULL`));
    }
    return foundByName[0]!.id;
  }
  const inserted = await tx
    .insert(series)
    .values({
      provider: args.provider,
      providerSeriesId: args.seriesAsin,
      name: args.name,
      normalizedName: normalized,
    })
    .returning({ id: series.id });
  return inserted[0]!.id;
}

/**
 * Replace series membership for a rematched book. Always deletes any prior
 * `series_members` rows for the book; inserts exactly one fresh row when
 * `args` is non-null. Errors propagate — caller's transaction rolls back.
 *
 * Diverges intentionally from the (private) add-book `upsertSeriesLink`,
 * which is best-effort catch-and-log — rematch series correctness is a core
 * acceptance criterion, so failures must abort the Fix Match transaction.
 */
export async function replaceSeriesLink(
  tx: DbOrTx,
  bookId: number,
  args: ReplaceSeriesLinkArgs | null,
): Promise<void> {
  await tx.delete(seriesMembers).where(eq(seriesMembers.bookId, bookId));
  if (!args) return;

  const normalized = normalizeSeriesName(args.name);
  const seriesId = await resolveSeriesId(tx, args, normalized);

  const positionRaw = args.position != null && Number.isFinite(args.position) ? String(args.position) : null;
  const normalizedTitle = normalizeSeriesMemberWorkTitle(args.title);
  await tx.insert(seriesMembers).values({
    seriesId,
    bookId,
    providerBookId: args.asin,
    title: args.title,
    normalizedTitle,
    authorName: args.authorName,
    positionRaw,
    position: args.position,
    source: 'provider',
  });
}

/**
 * Link `bookId` to an existing canonical `seriesMembers` row and fold
 * `candidateAsin` into `alternate_asins`. No-op when the ASIN matches the
 * canonical providerBookId or is already an alternate. (#1116 F1, #1117 review F1)
 */
async function linkExistingMember(
  tx: DbOrTx,
  existingId: number,
  bookId: number,
  candidateAsin: string | null,
): Promise<void> {
  const rows = await tx
    .select({ providerBookId: seriesMembers.providerBookId, alternateAsins: seriesMembers.alternateAsins })
    .from(seriesMembers)
    .where(eq(seriesMembers.id, existingId))
    .limit(1);
  const existing = rows[0];
  const update: Partial<typeof seriesMembers.$inferInsert> = { bookId, updatedAt: new Date() };
  const shouldFold = existing != null && candidateAsin != null && candidateAsin !== existing.providerBookId && !(existing.alternateAsins ?? []).includes(candidateAsin);
  if (shouldFold) {
    update.alternateAsins = [...new Set([...(existing!.alternateAsins ?? []), candidateAsin!])].sort();
  }
  await tx.update(seriesMembers).set(update).where(eq(seriesMembers.id, existingId));
}

/**
 * Upsert the (series + series_member) cache rows for a freshly-created book
 * when the create payload carries provider-known series identity.
 * Best-effort: failures are caught + logged so book create stays the success path.
 */
export async function upsertSeriesLink(
  tx: DbOrTx,
  log: FastifyBaseLogger,
  bookId: number,
  args: ReplaceSeriesLinkArgs,
): Promise<void> {
  try {
    const normalized = normalizeSeriesName(args.name);
    const seriesId = await resolveSeriesId(tx, args, normalized);

    const positionRaw = args.position != null && Number.isFinite(args.position) ? String(args.position) : null;
    const normalizedTitle = normalizeSeriesMemberWorkTitle(args.title);
    const normalizedAuthor = normalizePrimaryAuthor(args.authorName);
    const existingId = await findMemberByLogicalIdentity(
      tx,
      seriesId,
      normalizedTitle,
      positionRaw,
      normalizedAuthor,
      args.asin,
    );
    if (existingId !== null) {
      await linkExistingMember(tx, existingId, bookId, args.asin);
      return;
    }
    await tx.insert(seriesMembers).values({
      seriesId,
      bookId,
      providerBookId: args.asin,
      title: args.title,
      normalizedTitle,
      authorName: args.authorName,
      positionRaw,
      position: args.position,
      source: 'provider',
    });
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId, seriesName: args.name }, 'Series link upsert failed during book create');
  }
}
