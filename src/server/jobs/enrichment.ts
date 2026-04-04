import cron from 'node-cron';
import { eq, and, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, narrators, bookNarrators } from '../../db/schema.js';
import { slugify } from '../../core/index.js';
import { RateLimitError } from '../../core/index.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';

const BATCH_LIMIT = 5;
const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour

export function startEnrichmentJob(db: Db, metadataService: MetadataService, bookService: BookService, log: FastifyBaseLogger) {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runEnrichment(db, metadataService, bookService, log);
    } catch (error: unknown) {
      log.error(error, 'Enrichment job error');
    }
  });

  log.info('Enrichment job started (every 5 minutes)');
}

// eslint-disable-next-line complexity -- linear enrichment pipeline with null guards per category
export async function runEnrichment(db: Db, metadataService: MetadataService, bookService: BookService, log: FastifyBaseLogger) {
  const startMs = Date.now();
  let enrichedCount = 0;
  let filledDuration = 0;
  let filledNarrators = 0;
  let filledGenres = 0;
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
        .select({ duration: books.duration, genres: books.genres })
        .from(books)
        .where(eq(books.id, candidate.id))
        .limit(1);

      if (existing.length > 0) {
        const book = existing[0];
        if (!book.duration && result.duration) {
          updates.duration = result.duration;
          filledDuration++;
        }

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
            const name = result.narrators[i].trim();
            if (!name) continue;
            const slug = slugify(name);
            let [existing_n] = await db.select({ id: narrators.id }).from(narrators).where(eq(narrators.slug, slug)).limit(1);
            if (!existing_n) {
              const [created] = await db.insert(narrators).values({ name, slug }).onConflictDoNothing().returning();
              if (created) {
                existing_n = created;
              } else {
                [existing_n] = await db.select({ id: narrators.id }).from(narrators).where(eq(narrators.slug, slug)).limit(1);
              }
            }
            if (existing_n) {
              await db.insert(bookNarrators).values({ bookId: candidate.id, narratorId: existing_n.id, position: i }).onConflictDoNothing();
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
    log.info({ enrichedCount, filledDuration, filledNarrators, filledGenres, elapsedMs: Date.now() - startMs }, 'Enrichment batch completed');
  }
}
