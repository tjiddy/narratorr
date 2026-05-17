import type { FastifyBaseLogger } from 'fastify';
import type { SeriesCardService } from '../services/series-card.service.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Weekly job: walk stale series cache rows and refresh from Hardcover. The
 * service skips the entire sweep when no Hardcover key is configured.
 */
export async function runSeriesRefreshJob(
  service: SeriesCardService,
  log: FastifyBaseLogger,
): Promise<void> {
  const startMs = Date.now();
  try {
    const result = await service.runScheduledRefresh();
    log.info({ ...result, elapsedMs: Date.now() - startMs }, 'Series refresh batch completed');
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'Series refresh batch failed');
  }
}
