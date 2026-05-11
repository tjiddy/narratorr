import { eq, and, isNull, lte, or, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { SeriesRow, SeriesMemberRow } from './types.js';

/** Default backoff (ms) when a non-rate-limit refresh fails. */
export const DEFAULT_FAILURE_BACKOFF_MS = 60 * 60 * 1000; // 1h
/** Default backoff (ms) for a 429 without Retry-After header. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000; // 1h
/** Scheduled job freshness window — don't refetch a row refreshed sooner than this. */
export const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Provider key for Audible series cache rows. */
export const AUDIBLE_PROVIDER = 'audible';

export interface SeriesMemberCard {
  id: number;
  providerBookId: string | null;
  title: string;
  positionRaw: string | null;
  position: number | null;
  isCurrent: boolean;
  libraryBookId: number | null;
  coverUrl: string | null;
}

export interface BookSeriesCardData {
  id: number;
  name: string;
  providerSeriesId: string | null;
  lastFetchedAt: string | null;
  lastFetchStatus: 'success' | 'failed' | 'rate_limited' | null;
  nextFetchAfter: string | null;
  members: SeriesMemberCard[];
}

function normalizeMemberTitle(title: string): string {
  return normalizeSeriesName(title);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function findExistingSeriesRow(
  db: Db,
  opts: { providerSeriesId: string | null; seriesName: string | null; seedAsin?: string | null },
): Promise<SeriesRow | null> {
  // Strongest identity: walk from the seed book's ASIN through the member row
  // to its parent series. Catches provider-backed rows created by Add Book
  // even when the caller only knows the book ASIN. (F1)
  if (opts.seedAsin) {
    const rows = await db
      .select({ s: series })
      .from(seriesMembers)
      .innerJoin(series, eq(seriesMembers.seriesId, series.id))
      .where(eq(seriesMembers.providerBookId, opts.seedAsin))
      .limit(1);
    if (rows.length > 0) return rows[0]!.s as SeriesRow;
  }
  if (opts.providerSeriesId) {
    const rows = await db
      .select()
      .from(series)
      .where(and(eq(series.provider, AUDIBLE_PROVIDER), eq(series.providerSeriesId, opts.providerSeriesId)))
      .limit(1);
    if (rows.length > 0) return rows[0] as SeriesRow;
  }
  // Normalized-name fallback matches both provider-backed AND null-providerSeriesId rows.
  // The previous `isNull(providerSeriesId)` filter hid Add Book rows from manual refresh. (F1)
  if (opts.seriesName) {
    const normalized = normalizeSeriesName(opts.seriesName);
    const rows = await db
      .select()
      .from(series)
      .where(and(eq(series.provider, AUDIBLE_PROVIDER), eq(series.normalizedName, normalized)))
      .limit(1);
    if (rows.length > 0) return rows[0] as SeriesRow;
  }
  return null;
}

async function upsertSeriesRow(
  db: DbOrTx,
  existing: SeriesRow | null,
  name: string,
  providerSeriesId: string | null,
): Promise<SeriesRow> {
  if (existing) {
    const updates: Partial<typeof series.$inferInsert> = {
      name,
      normalizedName: normalizeSeriesName(name),
      updatedAt: new Date(),
    };
    if (providerSeriesId && !existing.providerSeriesId) {
      updates.providerSeriesId = providerSeriesId;
    }
    const rows = await db.update(series).set(updates).where(eq(series.id, existing.id)).returning();
    return rows[0] as SeriesRow;
  }
  const rows = await db
    .insert(series)
    .values({ provider: AUDIBLE_PROVIDER, providerSeriesId, name, normalizedName: normalizeSeriesName(name) })
    .returning();
  return rows[0] as SeriesRow;
}

function buildMemberValues(
  seriesId: number,
  product: BookMetadata,
  seriesName: string,
): typeof seriesMembers.$inferInsert {
  const seriesRef = product.series?.find((s) => s.name === seriesName) ?? product.series?.[0];
  const validPosition = seriesRef?.position != null && Number.isFinite(seriesRef.position) ? seriesRef.position : null;
  return {
    seriesId,
    providerBookId: product.asin ?? null,
    title: product.title,
    normalizedTitle: normalizeMemberTitle(product.title),
    authorName: product.authors[0]?.name ?? null,
    positionRaw: validPosition !== null ? String(validPosition) : null,
    position: validPosition,
    publishedDate: product.publishedDate ?? null,
    coverUrl: product.coverUrl ?? null,
    duration: product.duration ?? null,
    publisher: product.publisher ?? null,
    source: 'provider',
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
}

async function findExistingMemberId(
  db: DbOrTx,
  seriesId: number,
  providerBookId: string | null,
  normalizedTitle: string,
  positionRaw: string | null,
): Promise<number | null> {
  if (providerBookId) {
    const rows = await db
      .select({ id: seriesMembers.id })
      .from(seriesMembers)
      .where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.providerBookId, providerBookId)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const positionFilter = positionRaw !== null
    ? eq(seriesMembers.positionRaw, positionRaw)
    : isNull(seriesMembers.positionRaw);
  const rows = await db
    .select({ id: seriesMembers.id })
    .from(seriesMembers)
    .where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.normalizedTitle, normalizedTitle), positionFilter))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function upsertMember(db: DbOrTx, seriesId: number, product: BookMetadata, seriesName: string): Promise<void> {
  const values = buildMemberValues(seriesId, product, seriesName);
  const existingId = await findExistingMemberId(db, seriesId, product.asin ?? null, values.normalizedTitle, values.positionRaw ?? null);
  if (existingId !== null) {
    await db.update(seriesMembers).set({ ...values, seriesId }).where(eq(seriesMembers.id, existingId));
    return;
  }
  await db.insert(seriesMembers).values(values);
}

async function linkLocalBooksByAsin(db: DbOrTx, seriesId: number): Promise<void> {
  const unlinked = await db
    .select({ id: seriesMembers.id, providerBookId: seriesMembers.providerBookId })
    .from(seriesMembers)
    .where(and(eq(seriesMembers.seriesId, seriesId), isNull(seriesMembers.bookId), isNotNull(seriesMembers.providerBookId)));
  for (const member of unlinked) {
    if (!member.providerBookId) continue;
    const bookRows = await db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.asin, member.providerBookId))
      .limit(1);
    if (bookRows.length > 0) {
      await db
        .update(seriesMembers)
        .set({ bookId: bookRows[0]!.id, updatedAt: new Date() })
        .where(eq(seriesMembers.id, member.id));
    }
  }
}

// eslint-disable-next-line complexity -- success path coalesces multiple optional inputs
export async function applySuccessOutcome(
  db: Db,
  log: FastifyBaseLogger,
  existing: SeriesRow | null,
  products: BookMetadata[],
  seedAsin: string,
  opts: { seriesName?: string | null; providerSeriesId?: string | null },
): Promise<SeriesRow | null> {
  const seedProduct = products.find((p) => p.asin === seedAsin) ?? products[0] ?? null;
  const inferredName = seedProduct?.series?.[0]?.name ?? opts.seriesName ?? null;
  const inferredSeriesAsin = seedProduct?.series?.[0]?.asin ?? opts.providerSeriesId ?? null;
  const finalName = inferredName ?? (existing?.name ?? null);
  if (!finalName) {
    log.debug({ seedAsin }, 'Same-series response had no series name — skipping upsert');
    return existing;
  }

  // Atomic reconcile: series upsert + members + local-book linking + status flip
  // run in a single transaction so a midway failure can't leave half-written
  // members or a status row out of sync with cache contents. (F5, DB-2)
  return db.transaction(async (tx) => {
    const row = await upsertSeriesRow(tx, existing, finalName, inferredSeriesAsin ?? null);

    // Dedupe products by ASIN (Audible returns alternate editions)
    const dedupedByAsin = new Map<string, BookMetadata>();
    const noAsin: BookMetadata[] = [];
    for (const product of products) {
      if (product.asin) {
        if (!dedupedByAsin.has(product.asin)) dedupedByAsin.set(product.asin, product);
      } else {
        noAsin.push(product);
      }
    }
    for (const product of [...dedupedByAsin.values(), ...noAsin]) {
      await upsertMember(tx, row.id, product, finalName);
    }
    await linkLocalBooksByAsin(tx, row.id);

    const updated = await tx
      .update(series)
      .set({
        lastFetchedAt: new Date(),
        lastFetchStatus: 'success',
        lastFetchError: null,
        nextFetchAfter: null,
        updatedAt: new Date(),
      })
      .where(eq(series.id, row.id))
      .returning();
    return (updated[0] as SeriesRow) ?? row;
  });
}

export async function recordOutcome(
  db: Db,
  existing: SeriesRow | null,
  opts: { seriesName?: string | null; providerSeriesId?: string | null },
  fields: Partial<typeof series.$inferInsert>,
): Promise<SeriesRow | null> {
  if (existing) {
    const rows = await db
      .update(series)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(series.id, existing.id))
      .returning();
    return (rows[0] as SeriesRow) ?? null;
  }
  if (!opts.seriesName) return null;
  const rows = await db
    .insert(series)
    .values({
      provider: AUDIBLE_PROVIDER,
      providerSeriesId: opts.providerSeriesId ?? null,
      name: opts.seriesName,
      normalizedName: normalizeSeriesName(opts.seriesName),
      ...fields,
    })
    .returning();
  return (rows[0] as SeriesRow) ?? null;
}

export async function applyRateLimitOutcome(
  db: Db,
  existing: SeriesRow | null,
  retryAfterMs: number | undefined,
  errorMsg: string,
  opts: { seriesName?: string | null; providerSeriesId?: string | null },
): Promise<SeriesRow | null> {
  const next = new Date(Date.now() + (retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS));
  return recordOutcome(db, existing, opts, {
    lastFetchedAt: new Date(),
    lastFetchStatus: 'rate_limited',
    lastFetchError: errorMsg,
    nextFetchAfter: next,
  });
}

export async function applyFailureOutcome(
  db: Db,
  existing: SeriesRow | null,
  error: unknown,
  opts: { seriesName?: string | null; providerSeriesId?: string | null },
): Promise<SeriesRow | null> {
  const next = new Date(Date.now() + DEFAULT_FAILURE_BACKOFF_MS);
  return recordOutcome(db, existing, opts, {
    lastFetchedAt: new Date(),
    lastFetchStatus: 'failed',
    lastFetchError: errorMessage(error),
    nextFetchAfter: next,
  });
}

// ─── Scheduled selection ───────────────────────────────────────────────

async function pickSeedAsin(db: Db, seriesId: number): Promise<string | null> {
  const linked = await db
    .select({ asin: books.asin })
    .from(seriesMembers)
    .innerJoin(books, eq(seriesMembers.bookId, books.id))
    .where(and(eq(seriesMembers.seriesId, seriesId), isNotNull(books.asin)))
    .limit(1);
  if (linked.length > 0 && linked[0]!.asin) return linked[0]!.asin;
  const fromMember = await db
    .select({ providerBookId: seriesMembers.providerBookId })
    .from(seriesMembers)
    .where(and(eq(seriesMembers.seriesId, seriesId), isNotNull(seriesMembers.providerBookId)))
    .limit(1);
  return fromMember[0]?.providerBookId ?? null;
}

export interface ScheduledCandidate {
  id: number;
  seriesName: string;
  providerSeriesId: string | null;
  seedAsin: string;
}

export async function selectScheduledCandidates(db: Db): Promise<ScheduledCandidate[]> {
  const now = new Date();
  const freshThreshold = new Date(Date.now() - FRESHNESS_WINDOW_MS);
  const rows = await db
    .select({ id: series.id, name: series.name, providerSeriesId: series.providerSeriesId })
    .from(series)
    .where(and(
      or(isNull(series.nextFetchAfter), lte(series.nextFetchAfter, now)),
      or(isNull(series.lastFetchedAt), lte(series.lastFetchedAt, freshThreshold)),
    ))
    .limit(50);
  const result: ScheduledCandidate[] = [];
  for (const row of rows) {
    const seed = await pickSeedAsin(db, row.id);
    if (seed) {
      result.push({ id: row.id, seriesName: row.name, providerSeriesId: row.providerSeriesId, seedAsin: seed });
    }
  }
  return result;
}

// ─── Card builders ─────────────────────────────────────────────────────

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
    isCurrent: currentBook
      ? (m.bookId === currentBook.id || (!!m.providerBookId && !!currentBook.asin && m.providerBookId === currentBook.asin))
      : false,
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

function buildLocalOnlyCard(book: { id: number; asin: string | null; seriesName: string; seriesPosition: number | null }): BookSeriesCardData {
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
      title: '',
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
  book: { id: number; asin: string | null; seriesName: string | null; seriesPosition: number | null },
): Promise<BookSeriesCardData | null> {
  let seriesRow: SeriesRow | null = null;
  if (book.asin) {
    const rows = await db
      .select({ s: series })
      .from(seriesMembers)
      .innerJoin(series, eq(seriesMembers.seriesId, series.id))
      .where(eq(seriesMembers.providerBookId, book.asin))
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
    return buildCardFromRow(db, seriesRow, book);
  }
  if (book.seriesName) {
    return buildLocalOnlyCard({ ...book, seriesName: book.seriesName });
  }
  return null;
}

export async function readSeriesRow(
  db: Db,
  opts: { providerSeriesId?: string | null; seriesName?: string | null; seedAsin?: string | null },
): Promise<BookSeriesCardData | null> {
  const existing = await findExistingSeriesRow(db, {
    providerSeriesId: opts.providerSeriesId ?? null,
    seriesName: opts.seriesName ?? null,
    seedAsin: opts.seedAsin ?? null,
  });
  if (!existing) return null;
  return buildCardFromRow(db, existing);
}
