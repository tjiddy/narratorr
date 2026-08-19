import { eq, and, or, sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, bookAuthors, authors } from '@db/schema.js';
import { RateLimitError } from '@core/index.js';
import { serializeError } from '../utils/serialize-error.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';
import { withBookAdmissionLock } from '../utils/book-admission-lock.js';
import {
  applyResolvedEnrichmentWithinAdmissionLock,
  markFailedGuarded,
  type EnrichmentWriteback,
} from './enrichment-writeback.js';


const BATCH_LIMIT = 5;
const RETRY_AFTER_MS = 60 * 60 * 1000;
// Manual Fix Match resets failures that reach this cap back to pending.
const MAX_ENRICHMENT_ATTEMPTS = 5;

interface EnrichmentTotals {
  enrichedCount: number;
  filledDuration: number;
  filledNarrators: number;
  filledGenres: number;
  filledTitle: number;
  filledDescription: number;
}

function accumulate(totals: EnrichmentTotals, w: EnrichmentWriteback): void {
  if (!w.enriched) return;
  totals.enrichedCount++;
  totals.filledDuration += w.filledDuration;
  totals.filledNarrators += w.filledNarrators;
  totals.filledGenres += w.filledGenres;
  totals.filledTitle += w.filledTitle;
  totals.filledDescription += w.filledDescription;
}

export async function runEnrichment(db: Db, metadataService: MetadataService, bookService: BookService, log: FastifyBaseLogger) {
  const startMs = Date.now();
  const totals: EnrichmentTotals = {
    enrichedCount: 0, filledDuration: 0, filledNarrators: 0,
    filledGenres: 0, filledTitle: 0, filledDescription: 0,
  };

  // Re-run pending/skipped rows and old failures below the attempt cap.
  // Null-ASIN rows use the resolver's search fallback; authorless rows use title only.
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
    const capturedAsin = candidate.asin;
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
        break;
      }
      // Only null is a no-match; thrown provider errors remain retryable.
      log.warn({ bookId: candidate.id, asin: capturedAsin, error: serializeError(error) }, 'Transient provider error during enrichment — leaving candidate for next cycle');
      continue;
    }

    if (!result) {
      // The no-match failure write is part of the same per-book operation and takes the same lock.
      const marked = await withBookAdmissionLock(candidate.id, () =>
        markFailedGuarded(db, log, candidate.id, capturedAsin, 'no-match'));
      if (marked) log.warn({ bookId: candidate.id, asin: capturedAsin }, 'Book enrichment failed');
      continue;
    }

    // Per candidate, inside the loop: the provider round trip above must not be held, and one
    // acquisition around the batch would stall every other mutator for the length of the sweep.
    const written = await withBookAdmissionLock(candidate.id, () =>
      applyResolvedEnrichmentWithinAdmissionLock(db, bookService, log, candidate, capturedAsin, result));
    accumulate(totals, written);

    // Post-commit and outside the hold: telemetry is not part of the mutation it reports on.
    if (written.genresWritten) {
      await bookService.trackUnmatchedGenres(written.genresWritten).catch((error: unknown) => {
        log.debug({ error: serializeError(error) }, 'Failed to track unmatched genres');
      });
    }
  }

  if (candidates.length > 0) {
    log.info({ ...totals, elapsedMs: Date.now() - startMs }, 'Enrichment batch completed');
  }
}
