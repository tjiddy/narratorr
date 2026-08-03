import { sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { unmatchedGenres } from '@db/schema.js';
import { findUnmatchedGenres, normalizeGenres } from '@core/index.js';

/**
 * Fire-and-forget: track genres not in the synonym/known lists for future
 * analysis. Extracted from `book.service.ts` (at its `max-lines` cap); the body
 * is unchanged and `BookService.trackUnmatchedGenres` still delegates here, so
 * every existing caller and test keeps its shape.
 */
export async function trackUnmatchedGenres(
  db: Db,
  log: FastifyBaseLogger,
  genres: string[] | undefined,
): Promise<void> {
  const unmatched = findUnmatchedGenres(normalizeGenres(genres));
  if (unmatched.length === 0) return;

  for (const genre of unmatched) {
    await db
      .insert(unmatchedGenres)
      .values({ genre, count: 1 })
      .onConflictDoUpdate({
        target: unmatchedGenres.genre,
        set: {
          count: sql`${unmatchedGenres.count} + 1`,
          lastSeen: sql`(unixepoch())`,
        },
      });
  }
  log.debug({ genres: unmatched }, 'Tracked unmatched genres');
}
