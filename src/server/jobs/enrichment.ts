import { eq, and, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, bookNarrators, bookAuthors, authors } from '../../db/schema.js';
import { RateLimitError } from '../../core/index.js';
import { findOrCreateNarrator } from '../utils/find-or-create-person.js';
import { serializeError } from '../utils/serialize-error.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';


const BATCH_LIMIT = 5;
const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour

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

/**
 * Re-check the book row's ASIN against the value captured at enrichment-job
 * start. Drops writebacks whose target book has been re-identified mid-flight
 * (the Fix Match path swaps `books.asin` so the original enrichment payload no
 * longer applies to the row).
 *
 * `capturedAsin` is `string | null`: the candidate set now includes null-ASIN
 * rows (rescued via the search fallback), so the captured value can be null.
 * The JS `===` comparison handles `null === null` correctly.
 */
async function isStillSameAsin(db: Db, bookId: number, capturedAsin: string | null): Promise<boolean> {
  const rows = await db
    .select({ asin: books.asin })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  const current = rows[0]?.asin ?? null;
  return current === capturedAsin;
}

/**
 * Null-safe SQL predicate matching `books.asin` against the captured value.
 * `eq(books.asin, null)` compiles to `books.asin = NULL`, which never matches —
 * so a row whose captured ASIN was null would silently drop the writeback. Use
 * `isNull` when the captured value is null, `eq` otherwise.
 */
function asinMatches(capturedAsin: string | null) {
  return capturedAsin === null ? isNull(books.asin) : eq(books.asin, capturedAsin);
}

// `books.asin` carries a partial unique index (`idx_books_asin_unique` on the
// non-null column). A concurrent writer (Fix Match / import-list create) can
// take the resolved ASIN between `findAsinCollision` and the writeback, so the
// scalar UPDATE can still throw a UNIQUE violation. Detect it the way
// book-import.service.ts does — both the index-name and column-message forms,
// checking `error.cause?.message` first since Drizzle/libSQL nests the SQLite
// message under `.cause`.
const ASIN_UNIQUE_VIOLATION = /UNIQUE constraint failed.*(?:idx_books_asin_unique|books\.asin)/;

function isAsinUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const causeMsg = (error as Error & { cause?: { message?: string } }).cause?.message ?? '';
  if (ASIN_UNIQUE_VIOLATION.test(causeMsg)) return true;
  return ASIN_UNIQUE_VIOLATION.test(error.message ?? '');
}

/**
 * Mark a candidate `failed`, scoped `WHERE id = ? AND asin <matches captured>`
 * so a Fix Match that re-identified the row mid-flight drops the stale write
 * atomically (rather than clobbering the new identity's `enrichmentStatus`).
 * Returns true when a row was updated; on zero rows logs a stale-drop with the
 * caller's `pathTag` and returns false — the row was swapped, leave it alone.
 */
async function markFailedGuarded(
  db: Db,
  log: FastifyBaseLogger,
  bookId: number,
  capturedAsin: string | null,
  pathTag: string,
): Promise<boolean> {
  const rows = await db
    .update(books)
    .set({ enrichmentStatus: 'failed', updatedAt: new Date() })
    .where(and(eq(books.id, bookId), asinMatches(capturedAsin)))
    .returning({ id: books.id });
  if (rows.length === 0) {
    log.debug({ bookId, asin: capturedAsin }, `stale enrichment dropped (${pathTag})`);
    return false;
  }
  return true;
}

/**
 * Apply the success scalar UPDATE, scoped `WHERE id = ? AND asin <matches
 * captured>` so a Fix Match that swapped the row's identity between fetch and
 * writeback drops the stale write atomically (null-safe via `asinMatches`).
 *
 * On a UNIQUE violation — a concurrent writer (Fix Match / import-list create)
 * took the resolved ASIN between `findAsinCollision` and this write — run the
 * guarded recovery write to mark the candidate `failed` instead of letting the
 * throw abort the rest of the batch, and return true so the caller `continue`s.
 * Non-unique errors are genuine faults and rethrow, preserving existing
 * crash/log behavior. Returns false on the normal path (including a scalar
 * stale-drop) so the caller falls through to the success log.
 */
async function applyScalarWrite(
  db: Db,
  log: FastifyBaseLogger,
  bookId: number,
  capturedAsin: string | null,
  updates: Record<string, unknown>,
  resolvedAsin: string | null,
): Promise<boolean> {
  let scalarResult;
  try {
    scalarResult = await db
      .update(books)
      .set(updates)
      .where(and(eq(books.id, bookId), asinMatches(capturedAsin)))
      .returning({ id: books.id });
  } catch (error: unknown) {
    if (!isAsinUniqueViolation(error)) throw error;
    log.warn(
      { bookId, resolvedAsin, error: serializeError(error) },
      'Resolved ASIN hit a unique-constraint race — marking failed',
    );
    await markFailedGuarded(db, log, bookId, capturedAsin, 'unique recovery');
    return true;
  }
  if (scalarResult.length === 0) {
    log.debug({ bookId, asin: capturedAsin }, 'stale enrichment dropped (scalar update)');
  }
  return false;
}

/** Fill empty scalar fields from enrichment result. Returns only non-empty entries. */
function fillEmptyFields(book: ExistingBookFields, result: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<keyof ExistingBookFields> = ['subtitle', 'description', 'publisher', 'publishedDate'];
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    if (!book[field] && result[field]) updates[field] = result[field];
  }
  // coverUrl carve-out from fill-empty (#1634): the Audnexus square audiobook
  // cover is authoritative for an audiobook app, so it overwrites an existing
  // provider (print) cover rather than only filling when empty. Guard on the
  // result value's presence — Audnexus maps a missing cover to `undefined`
  // (`coverUrl: d.image || undefined`), so a no-image result leaves the cover
  // untouched and never blanks it. The pending/failed candidate gate keeps this
  // from re-clobbering a manual edit on an already-`enriched` book.
  if (result.coverUrl) updates.coverUrl = result.coverUrl;
  return updates;
}

/**
 * Fill series fields independently (matching library-scan.service.ts:432-433).
 * Prefers the Audnexus-derived `seriesPrimary` canonical ref, falling back to
 * `series[0]` only when `seriesPrimary` is absent — `series[0]` on Audible can
 * be a broader universe ref (e.g. Cosmere) rather than the real book series
 * (Stormlight Archive). (#1088 / #1097)
 */
function fillSeriesFields(
  book: ExistingBookFields,
  result: {
    seriesPrimary?: { name?: string | undefined; position?: number | undefined } | undefined;
    series?: Array<{ name?: string | undefined; position?: number | undefined }> | undefined;
  },
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const primary = result.seriesPrimary ?? result.series?.[0];
  if (!primary) return updates;
  if (primary.name && !book.seriesName) updates.seriesName = primary.name;
  if (primary.position != null && book.seriesPosition == null) updates.seriesPosition = primary.position;
  return updates;
}

/** Build the scalar updates and return fill counts for batch logging. */
function buildMetadataUpdates(
  book: ExistingBookFields,
  result: { title?: string | null | undefined; subtitle?: string | null | undefined; description?: string | null | undefined; publisher?: string | null | undefined; coverUrl?: string | null | undefined; publishedDate?: string | null | undefined; duration?: number | null | undefined; seriesPrimary?: { name?: string | undefined; position?: number | undefined } | undefined; series?: Array<{ name?: string | undefined; position?: number | undefined }> | undefined },
) {
  const updates: Record<string, unknown> = {};
  let filledDuration = 0;
  let filledTitle = 0;
  let filledDescription = 0;

  if (!book.duration && result.duration) {
    updates.duration = result.duration;
    filledDuration++;
  }

  if (result.title && isAllCaps(book.title) && result.title !== book.title) {
    updates.title = result.title;
    filledTitle++;
  }

  const scalarFills = fillEmptyFields(book, result as Record<string, unknown>);
  if (scalarFills.description) filledDescription++;
  Object.assign(updates, scalarFills);

  Object.assign(updates, fillSeriesFields(book, result));

  return { updates, filledDuration, filledTitle, filledDescription };
}

// eslint-disable-next-line complexity -- linear enrichment pipeline with null guards per category
export async function runEnrichment(db: Db, metadataService: MetadataService, bookService: BookService, log: FastifyBaseLogger) {
  const startMs = Date.now();
  let enrichedCount = 0;
  let filledDuration = 0;
  let filledNarrators = 0;
  let filledGenres = 0;
  let filledTitle = 0;
  let filledDescription = 0;

  // Candidates: pending (with OR without an ASIN), or failed older than 1 hour.
  // Null-ASIN rows are no longer short-circuited to 'skipped' — they're exactly
  // the books the search fallback in resolveBook is meant to rescue. The primary
  // (position-0) author is sourced from the book_authors/authors join (left-join
  // so authorless books are still selected; the resolver is then called
  // title-only). Only the title (plus the author when present) feeds the
  // resolver's search — it searches title+author only, so no ISBN is passed.
  const retryThreshold = new Date(Date.now() - RETRY_AFTER_MS);
  const candidates = await db
    .select({ id: books.id, asin: books.asin, title: books.title, author: authors.name })
    .from(books)
    .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
    .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
    .where(
      or(
        eq(books.enrichmentStatus, 'pending'),
        and(
          eq(books.enrichmentStatus, 'failed'),
          sql`${books.updatedAt} < ${Math.floor(retryThreshold.getTime() / 1000)}`,
        ),
      ),
    )
    .limit(BATCH_LIMIT);

  if (candidates.length === 0) {
    log.trace('No books pending enrichment');
    return;
  }

  log.info({ count: candidates.length }, 'Enriching books');

  for (const candidate of candidates) {
    const capturedAsin = candidate.asin; // string | null — null-ASIN rows are now eligible
    log.debug({ bookId: candidate.id, asin: capturedAsin }, 'Enriching book');

    let result;
    try {
      result = await metadataService.resolveBook({
        asin: capturedAsin ?? undefined,
        title: candidate.title,
        author: candidate.author ?? undefined,
      });
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        log.warn({ provider: error.provider, retryAfterMs: error.retryAfterMs }, 'Rate limited during enrichment — remaining candidates stay pending');
        break; // Remaining candidates stay pending for next cycle (includes fallback-search rate limits)
      }
      // Any other thrown error from resolveBook is a transient provider failure
      // (timeout / 5xx / malformed JSON), NOT a no-match — a real no-match returns
      // `null` (handled in the `else` below) and never throws. Leave this candidate
      // unchanged (still retryable next cycle) and continue the batch rather than
      // crashing it; do NOT mark the row `failed`.
      log.warn({ bookId: candidate.id, asin: capturedAsin, error: serializeError(error) }, 'Transient provider error during enrichment — leaving candidate for next cycle');
      continue;
    }

    if (result) {
      // The resolver may have recovered the real audiobook ASIN via search. If it
      // differs from the captured value, write it back so the next cycle stops
      // retrying the dead ASIN — but only after a collision check, since
      // `books.asin` is uniquely indexed. On collision we skip the ASIN write,
      // mark the row failed, and continue (never crash the batch).
      const resolvedAsin = result.asin ?? null;
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
          continue;
        }
      }

      const updates: Record<string, unknown> = {
        enrichmentStatus: 'enriched',
        updatedAt: new Date(),
      };
      if (asinChanged) updates.asin = resolvedAsin;

      // Only fill in fields that are currently empty
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

      if (existing.length > 0) {
        const book = existing[0]!;
        const filled = buildMetadataUpdates(book, result);
        Object.assign(updates, filled.updates);
        filledDuration += filled.filledDuration;
        filledTitle += filled.filledTitle;
        filledDescription += filled.filledDescription;

        // Fill genres via bookService.update() when existing genres are null or empty.
        // Re-check the row's ASIN before mutating to drop writes for books whose
        // identity was swapped under us (Fix Match). The genres path commits
        // through bookService.update(), which has no capturedAsin scope.
        if (result.genres?.length && (!book.genres || book.genres.length === 0)) {
          if (await isStillSameAsin(db, candidate.id, capturedAsin)) {
            await bookService.update(candidate.id, { genres: result.genres });
            filledGenres++;
          } else {
            log.debug({ bookId: candidate.id, asin: capturedAsin }, 'stale enrichment dropped (genres)');
          }
        }
      }

      // Fill in narrators from metadata if none in junction table yet.
      // Re-check ASIN at the loop boundary so a Fix Match that swapped the
      // book's identity prevents the loop from inserting stale junction rows.
      if (result.narrators?.length) {
        const existingNarrators = await db
          .select({ id: bookNarrators.narratorId })
          .from(bookNarrators)
          .where(eq(bookNarrators.bookId, candidate.id))
          .limit(1);
        if (existingNarrators.length === 0) {
          if (!(await isStillSameAsin(db, candidate.id, capturedAsin))) {
            log.debug({ bookId: candidate.id, asin: capturedAsin }, 'stale enrichment dropped (narrators)');
          } else {
            filledNarrators++;
            for (let i = 0; i < result.narrators.length; i++) {
              const name = result.narrators[i]!.trim();
              if (!name) continue;
              let narratorId: number | undefined;
              try {
                narratorId = await findOrCreateNarrator(db, name);
              } catch (_error: unknown) {
                // Skip this narrator — batch processing continues
              }
              if (narratorId !== undefined) {
                await db.insert(bookNarrators).values({ bookId: candidate.id, narratorId, position: i }).onConflictDoNothing();
              }
            }
          }
        }
      }

      // Scalar UPDATE: scope `WHERE id = ? AND asin <matches captured>` so a Fix
      // Match that swapped the row's identity between fetch and writeback drops
      // the stale write atomically. Null-safe: a captured-null row matches via
      // `asin IS NULL` (a plain `asin = NULL` predicate never matches, which
      // would silently drop the writeback for a search-rescued null-ASIN book).
      if (await applyScalarWrite(db, log, candidate.id, capturedAsin, updates, resolvedAsin)) {
        continue; // unique-constraint race recovered → candidate marked failed
      }

      enrichedCount++;
      log.info({ bookId: candidate.id, asin: resolvedAsin ?? capturedAsin }, 'Book enriched successfully');
    } else {
      if (await markFailedGuarded(db, log, candidate.id, capturedAsin, 'no-match')) {
        log.warn({ bookId: candidate.id, asin: capturedAsin }, 'Book enrichment failed');
      }
    }
  }

  if (candidates.length > 0) {
    log.info({ enrichedCount, filledDuration, filledNarrators, filledGenres, filledTitle, filledDescription, elapsedMs: Date.now() - startMs }, 'Enrichment batch completed');
  }
}
