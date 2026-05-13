import { eq, and, isNull, lte, or, isNotNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '../../db/index.js';
import { books, series, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { SeriesRow } from './types.js';
import {
  filterProductsToTarget,
  findMatchingSeriesRef,
  linkLocalBooksByAsin,
  reconcileCandidates,
  type TargetSeriesIdentity,
} from './series-refresh.dedupe.js';

// Re-exported for callers that need them (BookService.upsertSeriesLink, tests).
export { findMemberByLogicalIdentity, normalizePrimaryAuthor } from './series-refresh.dedupe.js';

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
  authorName: string | null;
  publishedDate: string | null;
  duration: number | null;
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
    // Widened to also match when the seed ASIN is one of a canonical row's
    // alternate_asins — the seed-biased canonical pick can otherwise orphan
    // alternate-ASIN reachability when the local book's ASIN differs from the
    // chosen providerBookId. (F12)
    const rows = await db
      .select({ s: series })
      .from(seriesMembers)
      .innerJoin(series, eq(seriesMembers.seriesId, series.id))
      .where(or(
        eq(seriesMembers.providerBookId, opts.seedAsin),
        sql`EXISTS (SELECT 1 FROM json_each(${seriesMembers.alternateAsins}) WHERE value = ${opts.seedAsin})`,
      ))
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
    // Write the freshly-derived provider series ASIN whenever it differs from
    // what's stored — covers both the fill-in-null case and the contamination
    // case where the existing row holds a stale wrong ASIN inherited from the
    // #1078 buggy fallback. `resolveTargetIdentity` only emits a different
    // ASIN when the existing row's name disagrees with the requested target,
    // so this won't fight a healthy row that already has the right id. (#1078 F1)
    if (providerSeriesId && providerSeriesId !== existing.providerSeriesId) {
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


/**
 * Resolve the target series identity for a same-series refresh. Precedence:
 *   1. `opts.providerSeriesId` — explicit caller input wins.
 *   2. The seed product's matching series ref (by requested name) — this is
 *      the most trustworthy cross-source ASIN because the seed book IS the
 *      current book and its series ref carries the canonical Audible series
 *      ASIN for the target.
 *   3. `existing.providerSeriesId` — ONLY when the existing row's normalized
 *      name matches the requested name. A name mismatch means the existing
 *      row was previously contaminated by the #1078 bug (e.g. a Stormlight
 *      book whose old buggy refresh persisted it in a Mistborn-titled row
 *      with Mistborn's ASIN). Trusting the stale ASIN there would re-admit
 *      the wrong series. (#1078 F1)
 *
 * Both fields can be null when the caller has nothing to anchor on.
 */
function resolveTargetIdentity(
  seedProduct: BookMetadata | null,
  existing: SeriesRow | null,
  opts: { seriesName?: string | null; providerSeriesId?: string | null },
): TargetSeriesIdentity {
  const requestedName = opts.seriesName ?? existing?.name ?? null;
  const normalizedName = requestedName ? normalizeSeriesName(requestedName) : null;
  if (opts.providerSeriesId) return { asin: opts.providerSeriesId, normalizedName };
  if (normalizedName && seedProduct) {
    const seedMatch = findMatchingSeriesRef(seedProduct, { asin: null, normalizedName });
    if (seedMatch?.asin) return { asin: seedMatch.asin, normalizedName };
  }
  if (existing?.providerSeriesId) {
    const namesAgree = !normalizedName || existing.normalizedName === normalizedName;
    if (namesAgree) return { asin: existing.providerSeriesId, normalizedName };
  }
  return { asin: null, normalizedName };
}

/**
 * Empty-or-empty-filtered branch: do NOT mark the row 'success' with zero
 * members. A successful zero-member outcome masks Add Book's locally-inserted
 * member row at read time (the deployed `No members known yet` bug, #1074). If
 * a row doesn't exist yet, skip upsert entirely so the local card path
 * renders. If a row exists, advance the freshness window. When the existing
 * row has zero members (the historical bug shape — `lastFetchStatus: 'success'`
 * plus empty `series_members`), also demote any lingering status so the
 * persisted row no longer carries the `success` claim the AC forbids.
 * Populated rows keep their existing status because their members are still
 * good — a transient empty response shouldn't demote a healthy populated row.
 *
 * Reused for two cases: provider returned zero products (#1074) AND provider
 * returned products but none matched the target series identity (#1078).
 */
async function applyEmptyOutcome(db: Db, existing: SeriesRow | null): Promise<SeriesRow | null> {
  if (!existing) return null;
  const existingMembers = await db
    .select({ id: seriesMembers.id })
    .from(seriesMembers)
    .where(eq(seriesMembers.seriesId, existing.id))
    .limit(1);
  const hasMembers = existingMembers.length > 0;
  const updates: Partial<typeof series.$inferInsert> = {
    lastFetchedAt: new Date(),
    updatedAt: new Date(),
  };
  if (!hasMembers) {
    updates.lastFetchStatus = null;
    updates.lastFetchError = null;
    updates.nextFetchAfter = null;
  }
  const rows = await db
    .update(series)
    .set(updates)
    .where(eq(series.id, existing.id))
    .returning();
  return (rows[0] as SeriesRow) ?? existing;
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
  const target = resolveTargetIdentity(seedProduct, existing, opts);
  // Prefer the matching series ref's display name + ASIN from the seed product
  // so the series row is upserted with the canonical title (e.g. `The
  // Stormlight Archive` vs `Stormlight Archive`) — never `seed.series[0]`
  // unconditionally, which is the #1078 bug shape. (#1078)
  const seedMatchedRef = seedProduct ? findMatchingSeriesRef(seedProduct, target) : null;
  const inferredName = (seedMatchedRef?.name && seedMatchedRef.name.length > 0)
    ? seedMatchedRef.name
    : (opts.seriesName ?? existing?.name ?? null);
  const inferredSeriesAsin = seedMatchedRef?.asin ?? target.asin ?? null;
  const finalName = inferredName;
  if (!finalName) {
    log.debug({ seedAsin }, 'Same-series response had no series name — skipping upsert');
    return existing;
  }

  if (products.length === 0) {
    log.debug({ seedAsin, seriesName: finalName }, 'Same-series response was empty — preserving local state, no success flip');
    return applyEmptyOutcome(db, existing);
  }

  // Scope to the target series. Audible's `similar_products` for a multi-
  // series book can include unrelated series + broader-universe entries; only
  // those whose `series` array contains the target identity (provider series
  // ASIN preferred, normalized name otherwise) are kept. (#1078)
  const filtered = filterProductsToTarget(products, target);
  if (filtered.length === 0) {
    log.debug(
      { seedAsin, seriesName: finalName, providerSeriesId: inferredSeriesAsin, productCount: products.length },
      'Same-series response had no products matching target series — preserving local state',
    );
    return applyEmptyOutcome(db, existing);
  }

  // Atomic reconcile: series upsert + members + local-book linking + status flip
  // run in a single transaction so a midway failure can't leave half-written
  // members or a status row out of sync with cache contents. (F5, DB-2)
  return db.transaction(async (tx) => {
    const row = await upsertSeriesRow(tx, existing, finalName, inferredSeriesAsin);

    await reconcileCandidates(tx, row.id, products, target, seedAsin);
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

interface ScheduledSeed {
  asin: string;
  /** Local-book context — present only when the seed ASIN came from a linked
   *  book in the library. Absent when only provider-side member rows exist. */
  book?: {
    id: number;
    title: string;
    seriesName: string | null;
    seriesPosition: number | null;
  };
}

/**
 * Pick the seed ASIN (and its linked-book context, when available) for a
 * scheduled refresh of a series row. Precedence:
 *   1. Lowest-`books.id` linked local book with a non-null ASIN — gives
 *      `runScheduledRefresh` enough book context to detect series-name
 *      contamination and steer the reconcile target.
 *   2. Provider-only member ASIN — fallback when no linked local book exists,
 *      preserving today's pure-provider behavior.
 *
 * The linked-book branch must order deterministically (lowest `books.id`) so
 * the choice does not silently flip across scheduled runs when multiple local
 * books are linked to the same series row. (#1082)
 */
async function pickScheduledSeed(db: Db, seriesId: number): Promise<ScheduledSeed | null> {
  const linked = await db
    .select({
      asin: books.asin,
      bookId: books.id,
      bookTitle: books.title,
      bookSeriesName: books.seriesName,
      bookSeriesPosition: books.seriesPosition,
    })
    .from(seriesMembers)
    .innerJoin(books, eq(seriesMembers.bookId, books.id))
    .where(and(eq(seriesMembers.seriesId, seriesId), isNotNull(books.asin)))
    .orderBy(books.id)
    .limit(1);
  const linkedRow = linked[0];
  if (linkedRow?.asin) {
    return {
      asin: linkedRow.asin,
      book: {
        id: linkedRow.bookId,
        title: linkedRow.bookTitle,
        seriesName: linkedRow.bookSeriesName,
        seriesPosition: linkedRow.bookSeriesPosition,
      },
    };
  }
  const fromMember = await db
    .select({ providerBookId: seriesMembers.providerBookId })
    .from(seriesMembers)
    .where(and(eq(seriesMembers.seriesId, seriesId), isNotNull(seriesMembers.providerBookId)))
    .limit(1);
  if (fromMember[0]?.providerBookId) return { asin: fromMember[0].providerBookId };
  return null;
}

export interface ScheduledCandidate {
  id: number;
  seriesName: string;
  providerSeriesId: string | null;
  seedAsin: string;
  /** Linked-local-book context. Present only when `seedAsin` came from a book
   *  in the library; absent for provider-only rows. (#1082) */
  bookId?: number;
  bookTitle?: string;
  bookSeriesName?: string | null;
  bookSeriesPosition?: number | null;
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
    const seed = await pickScheduledSeed(db, row.id);
    if (!seed) continue;
    const candidate: ScheduledCandidate = {
      id: row.id,
      seriesName: row.name,
      providerSeriesId: row.providerSeriesId,
      seedAsin: seed.asin,
    };
    if (seed.book) {
      candidate.bookId = seed.book.id;
      candidate.bookTitle = seed.book.title;
      candidate.bookSeriesName = seed.book.seriesName;
      candidate.bookSeriesPosition = seed.book.seriesPosition;
    }
    result.push(candidate);
  }
  return result;
}

// Card builders live in series-refresh.card-builder.ts to keep this file under
// the project max-lines budget.
