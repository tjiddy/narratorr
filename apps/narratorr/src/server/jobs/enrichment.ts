import cron from 'node-cron';
import { eq, and, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@narratorr/db/schema';
import type { MetadataService } from '../services/metadata.service.js';

const BATCH_LIMIT = 5;
const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour

export function startEnrichmentJob(db: Db, metadataService: MetadataService, log: FastifyBaseLogger) {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runEnrichment(db, metadataService, log);
    } catch (error) {
      log.error(error, 'Enrichment job error');
    }
  });

  log.info('Enrichment job started (every 5 minutes)');
}

export async function runEnrichment(db: Db, metadataService: MetadataService, log: FastifyBaseLogger) {
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
    return;
  }

  log.info({ count: candidates.length }, 'Enriching books');

  for (const candidate of candidates) {
    const asin = candidate.asin!;
    const result = await metadataService.enrichBook(asin);

    if (result) {
      const updates: Record<string, unknown> = {
        enrichmentStatus: 'enriched',
        updatedAt: new Date(),
      };

      // Only fill in fields that are currently empty
      const existing = await db
        .select({ narrator: books.narrator, duration: books.duration })
        .from(books)
        .where(eq(books.id, candidate.id))
        .limit(1);

      if (existing.length > 0) {
        const book = existing[0];
        if (!book.narrator && result.narrators?.length) {
          updates.narrator = result.narrators.join(', ');
        }
        if (!book.duration && result.duration) {
          updates.duration = result.duration;
        }
      }

      await db
        .update(books)
        .set(updates)
        .where(eq(books.id, candidate.id));

      log.info({ bookId: candidate.id, asin }, 'Book enriched successfully');
    } else {
      await db
        .update(books)
        .set({ enrichmentStatus: 'failed', updatedAt: new Date() })
        .where(eq(books.id, candidate.id));

      log.warn({ bookId: candidate.id, asin }, 'Book enrichment failed');
    }
  }
}
