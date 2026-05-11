import type { FastifyBaseLogger } from 'fastify';
import type { SeriesRefreshService } from '../services/series-refresh.service.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Weekly job: walk stale series cache rows and refresh from the active
 * metadata provider, slowly enough to respect provider rate limits.
 * Selection logic and backoff handling live in SeriesRefreshService.
 */
export async function runSeriesRefreshJob(
  service: SeriesRefreshService,
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
