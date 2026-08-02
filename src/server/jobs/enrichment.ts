import { eq, and, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, bookNarrators, bookAuthors, authors } from '@db/schema.js';
import { RateLimitError } from '@core/index.js';
import { findOrCreateNarrator } from '../utils/find-or-create-person.js';
import { serializeError } from '../utils/serialize-error.js';
import { isUniqueViolation } from '@shared/error-message.js';
import { canonicalizeAsin } from '@shared/asin.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import { parseClearedFields } from '../utils/cleared-fields.js';
import type { ClearableBookField } from '@shared/schemas/book.js';


const BATCH_LIMIT = 5;
const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour
// Cap on background-enrichment failure attempts. Once a `failed` row has been
// re-searched this many times it drops out of the candidate set and rests as a
// terminal `failed` row (recoverable via manual Fix Match, which resets it to
// `pending`). Bounds the silent recurring external load of the search rescue so
// unresolvable null-ASIN rows aren't re-searched forever.
const MAX_ENRICHMENT_ATTEMPTS = 5;

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
    .set({
      enrichmentStatus: 'failed',
      // Increment the persisted attempt counter so the candidate query can cap
      // unresolvable rows. Covers the no-match, collision, and unique-recovery
      // paths uniformly (every guarded failure transition routes through here).
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

/** The clearable fields this fill surface writes as plain scalars. */
const TOMBSTONABLE_SCALAR_FILLS = ['subtitle', 'description', 'publisher', 'publishedDate'] as const;

/**
 * Drop the writes a live tombstone suppresses (#2069 AC9). Mutates `updates` in
 * place, so the counters the caller derives from it are already post-suppression.
 *
 * `duration`, the all-caps `title` rewrite, `coverUrl`, `asin`, `enrichmentStatus`
 * and every technical/audio field are deliberately unaffected — none of them is
 * clearable through Edit Metadata, so none can carry a tombstone.
 */
function suppressTombstonedUpdates(
  updates: Record<string, unknown>,
  cleared: ReadonlySet<ClearableBookField>,
): void {
  for (const field of TOMBSTONABLE_SCALAR_FILLS) {
    if (cleared.has(field)) delete updates[field];
  }
  // The series pair is single-source (#1927 AC10): the `seriesName` tombstone
  // suppresses BOTH halves, never grafting a provider position onto a cleared name.
  if (cleared.has('seriesName')) {
    delete updates.seriesName;
    delete updates.seriesPosition;
  }
}

type EnrichmentWriteOutcome = 'applied' | 'stale' | 'unique-conflict';

/**
 * The candidate's whole durable write, in ONE transaction (#2069 AC11).
 *
 * Inside the transaction, in order: re-select `{ asin, user_cleared_fields }` on
 * the handle, abort on an identity change, drop every tombstoned key from the
 * already-prepared `updates`, then issue the scalar UPDATE and the genres write
 * together. The provider fetch and the fill-empty decisions for non-tombstone
 * reasons stay OUTSIDE, as they are today (`src/db/serial-transactions.ts`: keep
 * the surrounding work outside the transaction, re-read only the preconditions
 * inside). Re-reading is why there is no fence and no observation token — the
 * window a fence would narrow is closed entirely.
 *
 * A field dropped because it is tombstoned is a DECISION, not a failure: the rest
 * of the write proceeds and `enrichmentStatus` advances normally. Only an identity
 * mismatch yields `'stale'`, and the caller then emits no success counters or log.
 *
 * On a UNIQUE violation — a concurrent writer took the resolved ASIN between
 * `findAsinCollision` and this write — the throw rolls the transaction back and the
 * guarded recovery write marks the candidate `failed` OUTSIDE it, so the rest of
 * the batch continues. Non-unique errors are genuine faults and rethrow.
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
): Promise<{ outcome: EnrichmentWriteOutcome; filledGenres: number }> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({ asin: books.asin, userClearedFields: books.userClearedFields })
        .from(books)
        .where(eq(books.id, bookId))
        .limit(1);
      const row = rows[0];

      // Identity guard, same meaning as today's `asinMatches` predicate — just
      // observed early enough to skip the write. A MISSING row needs no branch of
      // its own: it cannot satisfy that predicate either, so it drops below.
      if (row && (row.asin ?? null) !== capturedAsin) {
        log.debug({ bookId, asin: capturedAsin }, 'stale enrichment dropped (identity re-read)');
        return { outcome: 'stale' as const, filledGenres: 0 };
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
        return { outcome: 'stale' as const, filledGenres: 0 };
      }

      // The genres write commits through `bookService.update`, which has no
      // captured-ASIN scope of its own — it inherits this transaction's guard, and
      // runs on the handle so it does not open a second (nested) transaction.
      if (genresToFill && !cleared.has('genres')) {
        await bookService.update(bookId, { genres: genresToFill }, { tx });
        return { outcome: 'applied' as const, filledGenres: 1 };
      }
      return { outcome: 'applied' as const, filledGenres: 0 };
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error, ASIN_UNIQUE_VIOLATION)) throw error;
    log.warn(
      { bookId, resolvedAsin, error: serializeError(error) },
      'Resolved ASIN hit a unique-constraint race — marking failed',
    );
    await markFailedGuarded(db, log, bookId, capturedAsin, 'unique recovery');
    return { outcome: 'unique-conflict', filledGenres: 0 };
  }
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
 * Fill series fields as one atomic single-source pair (#1927 AC10). The `(name,
 * position)` pair must always share ONE source, so enrichment never crosses a
 * stored user series with a metadata position:
 *
 * - Stored `seriesName` present (any position) → write NEITHER field. The stored
 *   pair is authoritative; a missing position on a named series is corrected via
 *   Fix Match / the metadata editor, not by grafting a metadata position on.
 * - Stored `seriesName` absent + metadata has a primary name → write BOTH
 *   atomically: `seriesName = primary.name` and `seriesPosition = primary.position
 *   ?? null`. NOT gated on the stored position, so a reachable orphan
 *   `{ seriesName: null, seriesPosition: 5 }` (Manual Add / independent writes) has
 *   its stale position overwritten or cleared to match the metadata name rather
 *   than surviving as `Provider Saga #5`. Position 0 survives (`?? null` keeps 0).
 * - No usable primary name → write nothing.
 *
 * Prefers the Audnexus-derived `seriesPrimary` canonical ref over `series[0]`
 * (#1088 / #1097) — `series[0]` on Audible can be a broader universe ref (Cosmere)
 * rather than the real book series (Stormlight Archive).
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
  if (!primary?.name || book.seriesName) return updates;
  updates.seriesName = primary.name;
  updates.seriesPosition = primary.position ?? null;
  return updates;
}

/**
 * Build the scalar updates for a candidate. Counts are NOT derived here: the
 * write transaction may still drop tombstoned keys (#2069 AC9), so the batch
 * counters are read off the surviving `updates` object after the write lands.
 */
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

// eslint-disable-next-line complexity -- linear enrichment pipeline with null guards per category
export async function runEnrichment(db: Db, metadataService: MetadataService, bookService: BookService, log: FastifyBaseLogger) {
  const startMs = Date.now();
  let enrichedCount = 0;
  let filledDuration = 0;
  let filledNarrators = 0;
  let filledGenres = 0;
  let filledTitle = 0;
  let filledDescription = 0;

  // Candidates: pending (with OR without an ASIN), pre-existing 'skipped' rows
  // (re-queued once through the search rescue — they motivated #1622 but were
  // orphaned by the pending/failed-only query), or failed older than 1 hour that
  // haven't hit the attempt cap. Null-ASIN rows are no longer short-circuited to
  // 'skipped' — they're exactly the books the search fallback in resolveBook is
  // meant to rescue. A 'skipped' row transitions to 'enriched'/'failed' on its
  // first pass and never returns to 'skipped', so it won't loop. The attempt cap
  // keeps unresolvable 'failed' rows from being re-searched forever; once maxed
  // out they rest as terminal 'failed' (recoverable via manual Fix Match). The
  // primary (position-0) author is sourced from the book_authors/authors join
  // (left-join so authorless books are still selected; the resolver is then
  // called title-only). Only the title (plus the author when present) feeds the
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
        eq(books.enrichmentStatus, 'skipped'),
        and(
          eq(books.enrichmentStatus, 'failed'),
          sql`${books.updatedAt} < ${Math.floor(retryThreshold.getTime() / 1000)}`,
          sql`${books.enrichmentAttempts} < ${MAX_ENRICHMENT_ATTEMPTS}`,
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
      // Canonicalize the resolved ASIN at this write boundary (#1733). `capturedAsin`
      // is read from the (canonical, post-migration) column, so a plain `!==` after
      // canonicalization is a correct case-insensitive change check.
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

      // Genres fill when the stored list is null or empty. The tombstone check and
      // the write both live in the write transaction below (#2069 AC11) — this only
      // decides whether there is anything to fill.
      let genresToFill: string[] | null = null;

      if (existing.length > 0) {
        const book = existing[0]!;
        Object.assign(updates, buildMetadataUpdates(book, result).updates);
        if (result.genres?.length && (!book.genres || book.genres.length === 0)) {
          genresToFill = result.genres;
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

      // One transaction for the scalar UPDATE + the genres write, with the
      // tombstone set and the row identity re-read inside it (#2069 AC11). The
      // scalar write keeps its `WHERE id = ? AND asin <matches captured>` scope so
      // a Fix Match that swapped the row's identity between fetch and writeback
      // still drops atomically. Null-safe: a captured-null row matches via
      // `asin IS NULL` (a plain `asin = NULL` predicate never matches, which
      // would silently drop the writeback for a search-rescued null-ASIN book).
      const written = await applyEnrichmentWrites(
        db, bookService, log, candidate.id, capturedAsin, updates, resolvedAsin, genresToFill,
      );
      // A stale drop is NOT a success: no fill counters, no 'Book enriched
      // successfully' line. Only fields that actually landed are counted, so a
      // tombstone-suppressed fill is not reported as filled either.
      if (written.outcome !== 'applied') continue;

      if ('duration' in updates) filledDuration++;
      if ('title' in updates) filledTitle++;
      if ('description' in updates) filledDescription++;
      filledGenres += written.filledGenres;

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
