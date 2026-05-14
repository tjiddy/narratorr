import { eq, and, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, bookNarrators } from '../../db/schema.js';
import { RateLimitError } from '../../core/index.js';
import { findOrCreateNarrator } from '../utils/find-or-create-person.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';


const BATCH_LIMIT = 5;
const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour

interface ExistingBookFields {
  duration: number | null;
  genres: string[] | null;
  title: string;
  description: string | null;
  coverUrl: string | null;
  publishedDate: string | null;
  seriesName: string | null;
  seriesPosition: number | null;
}

function isAllCaps(title: string): boolean {
  return title === title.toUpperCase() && title !== title.toLowerCase();
}

/** Fill empty scalar fields from enrichment result. Returns only non-empty entries. */
function fillEmptyFields(book: ExistingBookFields, result: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<keyof ExistingBookFields> = ['description', 'coverUrl', 'publishedDate'];
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    if (!book[field] && result[field]) updates[field] = result[field];
  }
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
  result: { title?: string | null | undefined; description?: string | null | undefined; coverUrl?: string | null | undefined; publishedDate?: string | null | undefined; duration?: number | null | undefined; seriesPrimary?: { name?: string | undefined; position?: number | undefined } | undefined; series?: Array<{ name?: string | undefined; position?: number | undefined }> | undefined },
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
  // Skip books without ASIN → set to 'skipped'
  const noAsinBooks = await db
    .select({ id: books.id })
    .from(books)
    .where(and(
      eq(books.enrichmentStatus, 'pending'),
      sql`${books.asin} IS NULL`,
    ));

  if (noAsinBooks.length > 0) {
    const ids = noAsinBooks.map((b) => b.id);
    for (const id of ids) {
      await db
        .update(books)
        .set({ enrichmentStatus: 'skipped', updatedAt: new Date() })
        .where(eq(books.id, id));
    }
    log.info({ count: ids.length }, 'Books without ASIN marked as skipped');
  }

  // Get books to enrich: pending with ASIN, or failed older than 1 hour
  const retryThreshold = new Date(Date.now() - RETRY_AFTER_MS);
  const candidates = await db
    .select({ id: books.id, asin: books.asin })
    .from(books)
    .where(and(
      isNotNull(books.asin),
      or(
        eq(books.enrichmentStatus, 'pending'),
        and(
          eq(books.enrichmentStatus, 'failed'),
          sql`${books.updatedAt} < ${Math.floor(retryThreshold.getTime() / 1000)}`,
        ),
      ),
    ))
    .limit(BATCH_LIMIT);

  if (candidates.length === 0) {
    log.trace('No books pending enrichment');
    return;
  }

  log.info({ count: candidates.length }, 'Enriching books');

  for (const candidate of candidates) {
    const asin = candidate.asin!;
    log.debug({ bookId: candidate.id, asin }, 'Enriching book');

    let result;
    try {
      result = await metadataService.enrichBook(asin);
    } catch (error: unknown) {
      if (error instanceof RateLimitError) {
        log.warn({ provider: error.provider, retryAfterMs: error.retryAfterMs }, 'Rate limited during enrichment — remaining candidates stay pending');
        break; // Remaining candidates stay pending for next cycle
      }
      throw error;
    }

    if (result) {
      const updates: Record<string, unknown> = {
        enrichmentStatus: 'enriched',
        updatedAt: new Date(),
      };

      // Only fill in fields that are currently empty
      const existing = await db
        .select({
          duration: books.duration,
          genres: books.genres,
          title: books.title,
          description: books.description,
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

        // Fill genres via bookService.update() when existing genres are null or empty
        if (result.genres?.length && (!book.genres || book.genres.length === 0)) {
          await bookService.update(candidate.id, { genres: result.genres });
          filledGenres++;
        }
      }

      // Fill in narrators from metadata if none in junction table yet
      if (result.narrators?.length) {
        const existingNarrators = await db
          .select({ id: bookNarrators.narratorId })
          .from(bookNarrators)
          .where(eq(bookNarrators.bookId, candidate.id))
          .limit(1);
        if (existingNarrators.length === 0) {
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

      await db
        .update(books)
        .set(updates)
        .where(eq(books.id, candidate.id));

      enrichedCount++;
      log.info({ bookId: candidate.id, asin }, 'Book enriched successfully');
    } else {
      await db
        .update(books)
        .set({ enrichmentStatus: 'failed', updatedAt: new Date() })
        .where(eq(books.id, candidate.id));

      log.warn({ bookId: candidate.id, asin }, 'Book enrichment failed');
    }
  }

  if (candidates.length > 0) {
    log.info({ enrichedCount, filledDuration, filledNarrators, filledGenres, filledTitle, filledDescription, elapsedMs: Date.now() - startMs }, 'Enrichment batch completed');
  }
}
