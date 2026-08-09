import { sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { unmatchedGenres } from '@db/schema.js';
import { findUnmatchedGenres, normalizeGenres } from '@core/index.js';

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
