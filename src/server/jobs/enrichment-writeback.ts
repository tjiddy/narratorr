import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, bookNarrators } from '@db/schema.js';
import { findOrCreateNarrator } from '../utils/find-or-create-person.js';
import { serializeError } from '../utils/serialize-error.js';
import { isUniqueViolation } from '@shared/error-message.js';
import { canonicalizeAsin } from '@shared/asin.js';
import type { BookService } from '../services/book.service.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import { usefulString } from '../services/metadata-recording-collapse.js';
import { parseClearedFields } from '../utils/cleared-fields.js';
import type { ClearableBookField } from '@shared/schemas/book.js';

/**
 * The scheduled sweep's per-book writeback. Everything here runs inside ONE admission acquisition
 * taken by the caller per candidate — never around the batch, and never around the provider I/O
 * that precedes it.
 */

interface ExistingBookFields {
  duration: number | null;
  genres: string[] | null;
  title: string;
  subtitle: string | null;
  description: string | null;
  publisher: string | null;
  coverUrl: string | null;
  publishedDate: string | null;
  seriesName: string | null;
  seriesPosition: number | null;
}

function isAllCaps(title: string): boolean {
  return title === title.toUpperCase() && title !== title.toLowerCase();
}

// Drop narrator writes if Fix Match changed the book identity mid-run.
async function isStillSameAsin(db: Db, bookId: number, capturedAsin: string | null): Promise<boolean> {
  const rows = await db
    .select({ asin: books.asin })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  const current = rows[0]?.asin ?? null;
  return current === capturedAsin;
}

// SQL equality never matches NULL; null-ASIN candidates require IS NULL.
function asinMatches(capturedAsin: string | null) {
  return capturedAsin === null ? isNull(books.asin) : eq(books.asin, capturedAsin);
}

// Fix Match/import can win after the collision check; SQLite may name the index or column.
const ASIN_UNIQUE_VIOLATION = /UNIQUE constraint failed.*(?:idx_books_asin_unique|books\.asin)/;

// Scope failure writes to the captured identity; zero rows means Fix Match won the race.
async function markFailedGuarded(
  db: Db,
  log: FastifyBaseLogger,
  bookId: number,
  capturedAsin: string | null,
  pathTag: string,
): Promise<boolean> {
  const rows = await db
    .update(books)
    .set({
      enrichmentStatus: 'failed',
      // Every failure path shares this persisted retry cap.
      enrichmentAttempts: sql`${books.enrichmentAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(books.id, bookId), asinMatches(capturedAsin)))
    .returning({ id: books.id });
  if (rows.length === 0) {
    log.debug({ bookId, asin: capturedAsin }, `stale enrichment dropped (${pathTag})`);
    return false;
  }
  return true;
}

const TOMBSTONABLE_SCALAR_FILLS = ['subtitle', 'description', 'publisher', 'publishedDate'] as const;

function suppressTombstonedUpdates(
  updates: Record<string, unknown>,
  cleared: ReadonlySet<ClearableBookField>,
): void {
  for (const field of TOMBSTONABLE_SCALAR_FILLS) {
    if (cleared.has(field)) delete updates[field];
  }
  // A cleared series name suppresses the whole single-source pair.
  if (cleared.has('seriesName')) {
    delete updates.seriesName;
    delete updates.seriesPosition;
  }
  // Keep the key so a cleared position overwrites any orphan beside a fresh provider name.
  if (cleared.has('seriesPosition') && 'seriesPosition' in updates) {
    updates.seriesPosition = null;
  }
}

type EnrichmentWriteOutcome = 'applied' | 'stale' | 'unique-conflict';

/**
 * Re-read identity and tombstones in the transaction, then commit scalar and genre
 * writes atomically. Tombstones suppress fields without failing the pass. Genre
 * telemetry returns to the owner for post-commit execution. A raced ASIN conflict
 * rolls back and becomes a guarded failure; other errors rethrow.
 */
async function applyEnrichmentWrites(
  db: Db,
  bookService: BookService,
  log: FastifyBaseLogger,
  bookId: number,
  capturedAsin: string | null,
  updates: Record<string, unknown>,
  resolvedAsin: string | null,
  genresToFill: string[] | null,
): Promise<{ outcome: EnrichmentWriteOutcome; filledGenres: number; genresWritten: string[] | null }> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({ asin: books.asin, userClearedFields: books.userClearedFields })
        .from(books)
        .where(eq(books.id, bookId))
        .limit(1);
      const row = rows[0];

      // A missing row needs no branch; it drops through to the guarded update.
      if (row && (row.asin ?? null) !== capturedAsin) {
        log.debug({ bookId, asin: capturedAsin }, 'stale enrichment dropped (identity re-read)');
        return { outcome: 'stale' as const, filledGenres: 0, genresWritten: null };
      }

      const cleared = new Set(parseClearedFields(row?.userClearedFields ?? null, log, bookId));
      suppressTombstonedUpdates(updates, cleared);

      const scalarResult = await tx
        .update(books)
        .set(updates)
        .where(and(eq(books.id, bookId), asinMatches(capturedAsin)))
        .returning({ id: books.id });

      if (scalarResult.length === 0) {
        log.debug({ bookId, asin: capturedAsin }, 'stale enrichment dropped (scalar update)');
        return { outcome: 'stale' as const, filledGenres: 0, genresWritten: null };
      }

      // The transaction's identity guard scopes this service call and avoids nesting.
      if (genresToFill && !cleared.has('genres')) {
        await bookService.update(bookId, { genres: genresToFill }, { tx });
        return { outcome: 'applied' as const, filledGenres: 1, genresWritten: genresToFill };
      }
      return { outcome: 'applied' as const, filledGenres: 0, genresWritten: null };
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error, ASIN_UNIQUE_VIOLATION)) throw error;
    log.warn(
      { bookId, resolvedAsin, error: serializeError(error) },
      'Resolved ASIN hit a unique-constraint race — marking failed',
    );
    await markFailedGuarded(db, log, bookId, capturedAsin, 'unique recovery');
    return { outcome: 'unique-conflict', filledGenres: 0, genresWritten: null };
  }
}

function fillEmptyFields(book: ExistingBookFields, result: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<keyof ExistingBookFields> = ['subtitle', 'description', 'publisher', 'publishedDate'];
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    if (!book[field] && result[field]) updates[field] = result[field];
  }
  // Audnexus' audiobook cover is authoritative, but an absent result must not erase one.
  if (result.coverUrl) updates.coverUrl = result.coverUrl;
  return updates;
}

/**
 * Keep the series pair single-source. A stored name wins entirely; otherwise write
 * the provider name and position together, replacing any orphan position. Prefer
 * canonical `seriesPrimary` because `series[0]` may describe a broader universe.
 */
function fillSeriesFields(
  book: ExistingBookFields,
  result: {
    seriesPrimary?: { name?: string | undefined; position?: number | undefined } | undefined;
    series?: Array<{ name?: string | undefined; position?: number | undefined }> | undefined;
  },
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const primary = pickPrimarySeries(result);
  // usefulString is a plain boolean, so the presence arm carries the narrowing for the dereference.
  if (!primary || !usefulString(primary.name) || book.seriesName) return updates;
  updates.seriesName = primary.name;
  updates.seriesPosition = primary.position ?? null;
  return updates;
}

// Counters are derived after transactional tombstone suppression, not here.
function buildMetadataUpdates(
  book: ExistingBookFields,
  result: { title?: string | null | undefined; subtitle?: string | null | undefined; description?: string | null | undefined; publisher?: string | null | undefined; coverUrl?: string | null | undefined; publishedDate?: string | null | undefined; duration?: number | null | undefined; seriesPrimary?: { name?: string | undefined; position?: number | undefined } | undefined; series?: Array<{ name?: string | undefined; position?: number | undefined }> | undefined },
) {
  const updates: Record<string, unknown> = {};

  if (!book.duration && result.duration) {
    updates.duration = result.duration;
  }

  if (result.title && isAllCaps(book.title) && result.title !== book.title) {
    updates.title = result.title;
  }

  Object.assign(updates, fillEmptyFields(book, result as Record<string, unknown>));
  Object.assign(updates, fillSeriesFields(book, result));

  return { updates };
}


/** Counter deltas the sweep accumulates; genre telemetry is handed back for post-commit execution. */
export interface EnrichmentWriteback {
  enriched: boolean;
  filledDuration: number;
  filledNarrators: number;
  filledGenres: number;
  filledTitle: number;
  filledDescription: number;
  /** Non-null only when genres actually landed, so the owner never reports an unwritten effect. */
  genresWritten: string[] | null;
}

const NOTHING: EnrichmentWriteback = {
  enriched: false, filledDuration: 0, filledNarrators: 0, filledGenres: 0,
  filledTitle: 0, filledDescription: 0, genresWritten: null,
};

export interface ResolvedEnrichmentCandidate {
  id: number;
  title: string;
}

/** The provider fields the writeback consumes; widened only where the resolver is loose. */
export interface ResolvedEnrichmentResult {
  asin?: string | null | undefined;
  narrators?: string[] | undefined;
  genres?: string[] | undefined;
  title?: string | null | undefined;
  subtitle?: string | null | undefined;
  description?: string | null | undefined;
  publisher?: string | null | undefined;
  coverUrl?: string | null | undefined;
  publishedDate?: string | null | undefined;
  duration?: number | null | undefined;
  seriesPrimary?: { name?: string | undefined; position?: number | undefined } | undefined;
  series?: Array<{ name?: string | undefined; position?: number | undefined }> | undefined;
}

/**
 * Caller must hold the admission lock for `candidate.id`.
 *
 * One operation, deliberately: the collision check, the fill-empty snapshot, the narrator junction
 * inserts and the scalar/genre commit all key on the SAME captured identity. Before this was one
 * section, a Fix Match could land after `isStillSameAsin` passed and before the first narrator
 * insert — the later scalar guard then dropped its own write while the stale narrators it could
 * not see were already committed.
 *
 * The fill-empty snapshot is read here rather than by the sweep for the same reason: an owner edit
 * to a same-ASIN field would otherwise land after the prefetch and be overwritten by it.
 */
// eslint-disable-next-line complexity -- linear writeback with a null guard per provider category
export async function applyResolvedEnrichmentWithinAdmissionLock(
  db: Db,
  bookService: BookService,
  log: FastifyBaseLogger,
  candidate: ResolvedEnrichmentCandidate,
  capturedAsin: string | null,
  result: ResolvedEnrichmentResult,
): Promise<EnrichmentWriteback> {
  // Persist search-recovered identities only after canonicalization and collision checks.
  // Captured database ASINs are already canonical, so !== is case-insensitive in practice.
  const resolvedAsin = canonicalizeAsin(result.asin);
  const asinChanged = resolvedAsin !== null && resolvedAsin !== capturedAsin;

  if (asinChanged) {
    const collision = await bookService.findAsinCollision(candidate.id, resolvedAsin);
    if (collision) {
      if (await markFailedGuarded(db, log, candidate.id, capturedAsin, 'collision')) {
        log.warn(
          { bookId: candidate.id, resolvedAsin, conflictBookId: collision.conflictBookId },
          'Resolved ASIN collides with an existing book — marking failed',
        );
      }
      return NOTHING;
    }
  }

  const updates: Record<string, unknown> = {
    enrichmentStatus: 'enriched',
    updatedAt: new Date(),
  };
  if (asinChanged) updates.asin = resolvedAsin;

  const existing = await db
    .select({
      duration: books.duration,
      genres: books.genres,
      title: books.title,
      subtitle: books.subtitle,
      description: books.description,
      publisher: books.publisher,
      coverUrl: books.coverUrl,
      publishedDate: books.publishedDate,
      seriesName: books.seriesName,
      seriesPosition: books.seriesPosition,
    })
    .from(books)
    .where(eq(books.id, candidate.id))
    .limit(1);

  // Tombstone authority is re-read in the transaction; this only prepares a fill.
  let genresToFill: string[] | null = null;

  if (existing.length > 0) {
    const book = existing[0]!;
    Object.assign(updates, buildMetadataUpdates(book, result).updates);
    if (result.genres?.length && (!book.genres || book.genres.length === 0)) {
      genresToFill = result.genres;
    }
  }

  const filledNarrators = await insertNarratorsIfEmpty(db, log, candidate.id, capturedAsin, result.narrators);

  const written = await applyEnrichmentWrites(
    db, bookService, log, candidate.id, capturedAsin, updates, resolvedAsin, genresToFill,
  );
  // Count only writes that survived identity and tombstone guards.
  if (written.outcome !== 'applied') return NOTHING;

  log.info({ bookId: candidate.id, asin: resolvedAsin ?? capturedAsin }, 'Book enriched successfully');
  return {
    enriched: true,
    filledDuration: 'duration' in updates ? 1 : 0,
    filledTitle: 'title' in updates ? 1 : 0,
    filledDescription: 'description' in updates ? 1 : 0,
    filledGenres: written.filledGenres,
    filledNarrators,
    genresWritten: written.genresWritten,
  };
}

/** Returns 1 when this pass claimed the narrator fill, matching the sweep's existing counter. */
async function insertNarratorsIfEmpty(
  db: Db,
  log: FastifyBaseLogger,
  bookId: number,
  capturedAsin: string | null,
  narrators: string[] | undefined,
): Promise<number> {
  if (!narrators?.length) return 0;

  const existingNarrators = await db
    .select({ id: bookNarrators.narratorId })
    .from(bookNarrators)
    .where(eq(bookNarrators.bookId, bookId))
    .limit(1);
  if (existingNarrators.length > 0) return 0;

  if (!(await isStillSameAsin(db, bookId, capturedAsin))) {
    log.debug({ bookId, asin: capturedAsin }, 'stale enrichment dropped (narrators)');
    return 0;
  }

  for (let i = 0; i < narrators.length; i++) {
    const name = narrators[i]!.trim();
    if (!name) continue;
    let narratorId: number | undefined;
    try {
      narratorId = await findOrCreateNarrator(db, name);
    } catch (_error: unknown) {
      // One bad narrator must not abort the book or batch.
    }
    if (narratorId !== undefined) {
      await db.insert(bookNarrators).values({ bookId, narratorId, position: i }).onConflictDoNothing();
    }
  }
  return 1;
}

export { markFailedGuarded };
