import { eq, and, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { series, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import type { SeriesRow, SeriesMemberRow } from './types.js';
import {
  AUDIBLE_PROVIDER,
  findExistingSeriesRow,
  type BookSeriesCardData,
  type SeriesMemberCard,
} from './series-refresh.helpers.js';

function isMemberCurrent(
  member: { id?: unknown; bookId: number | null; providerBookId: string | null; alternateAsins: string[] },
  currentBook: { id: number; asin: string | null } | undefined,
): boolean {
  if (!currentBook) return false;
  if (member.bookId === currentBook.id) return true;
  if (!currentBook.asin) return false;
  if (member.providerBookId === currentBook.asin) return true;
  // The canonical pick may be biased away from the current book's ASIN; checking
  // alternate_asins keeps isCurrent correct across alternate-edition collapse. (F12)
  return member.alternateAsins.includes(currentBook.asin);
}

export async function buildCardFromRow(
  db: Db,
  row: SeriesRow,
  currentBook?: { id: number; asin: string | null },
): Promise<BookSeriesCardData> {
  const memberRows = await db
    .select()
    .from(seriesMembers)
    .where(eq(seriesMembers.seriesId, row.id))
    .orderBy(seriesMembers.position, seriesMembers.id);
  const members: SeriesMemberCard[] = (memberRows as SeriesMemberRow[]).map((m) => ({
    id: m.id,
    providerBookId: m.providerBookId,
    title: m.title,
    positionRaw: m.positionRaw,
    position: m.position,
    isCurrent: isMemberCurrent(m, currentBook),
    libraryBookId: m.bookId,
    coverUrl: m.coverUrl,
  }));
  return {
    id: row.id,
    name: row.name,
    providerSeriesId: row.providerSeriesId,
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    lastFetchStatus: row.lastFetchStatus,
    nextFetchAfter: row.nextFetchAfter?.toISOString() ?? null,
    members,
  };
}

function buildLocalOnlyCard(book: { id: number; title: string; asin: string | null; seriesName: string; seriesPosition: number | null }): BookSeriesCardData {
  return {
    id: -1,
    name: book.seriesName,
    providerSeriesId: null,
    lastFetchedAt: null,
    lastFetchStatus: null,
    nextFetchAfter: null,
    members: [{
      id: -1,
      providerBookId: book.asin,
      title: book.title,
      positionRaw: book.seriesPosition != null ? String(book.seriesPosition) : null,
      position: book.seriesPosition,
      isCurrent: true,
      libraryBookId: book.id,
      coverUrl: null,
    }],
  };
}

export async function buildCardData(
  db: Db,
  book: { id: number; title: string; asin: string | null; seriesName: string | null; seriesPosition: number | null },
): Promise<BookSeriesCardData | null> {
  let seriesRow: SeriesRow | null = null;
  if (book.asin) {
    // Widened to also resolve via alternate_asins so a book whose ASIN was
    // collapsed under a different canonical providerBookId still reaches its
    // series card, even without a cached book.seriesName. (F12)
    const rows = await db
      .select({ s: series })
      .from(seriesMembers)
      .innerJoin(series, eq(seriesMembers.seriesId, series.id))
      .where(or(
        eq(seriesMembers.providerBookId, book.asin),
        sql`EXISTS (SELECT 1 FROM json_each(${seriesMembers.alternateAsins}) WHERE value = ${book.asin})`,
      ))
      .limit(1);
    if (rows.length > 0) seriesRow = rows[0]!.s as SeriesRow;
  }
  if (!seriesRow && book.seriesName) {
    const rows = await db
      .select()
      .from(series)
      .where(and(eq(series.provider, AUDIBLE_PROVIDER), eq(series.normalizedName, normalizeSeriesName(book.seriesName))))
      .limit(1);
    if (rows.length > 0) seriesRow = rows[0] as SeriesRow;
  }
  if (seriesRow) {
    const card = await buildCardFromRow(db, seriesRow, book);
    // Read-time remediation for historical zero-member rows produced by the
    // pre-fix empty-provider-response bug. If the row exists but has no
    // members and the current book matches by normalized series name,
    // synthesize the current book as the sole member so the card doesn't
    // render "No members known yet". The next successful provider refresh
    // populates the row and this fallback stops firing.
    if (card.members.length === 0 && book.seriesName
        && normalizeSeriesName(book.seriesName) === seriesRow.normalizedName) {
      card.members = [{
        id: -1,
        providerBookId: book.asin,
        title: book.title,
        positionRaw: book.seriesPosition != null ? String(book.seriesPosition) : null,
        position: book.seriesPosition,
        isCurrent: true,
        libraryBookId: book.id,
        coverUrl: null,
      }];
    }
    return card;
  }
  if (book.seriesName) {
    return buildLocalOnlyCard({ ...book, seriesName: book.seriesName });
  }
  return null;
}

export async function readSeriesRow(
  db: Db,
  opts: { providerSeriesId?: string | null; seriesName?: string | null; seedAsin?: string | null },
  currentBook?: { id: number; asin: string | null },
): Promise<BookSeriesCardData | null> {
  const existing = await findExistingSeriesRow(db, {
    providerSeriesId: opts.providerSeriesId ?? null,
    seriesName: opts.seriesName ?? null,
    seedAsin: opts.seedAsin ?? null,
  });
  if (!existing) return null;
  return buildCardFromRow(db, existing, currentBook);
}
