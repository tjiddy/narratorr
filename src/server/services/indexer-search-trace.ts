import type { FastifyBaseLogger } from 'fastify';
import type { IndexerSearchResponse } from '../../core/index.js';
import type { IndexerRow } from './types.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';

/**
 * Emit the per-indexer "Indexer search complete" summary and one debug
 * line per dropped item. AC2 trace point — every search call site uses
 * this so `grep 'Indexer search complete'` returns a homogeneous stream
 * regardless of which call path produced the search.
 */
export function logIndexerSearchTrace(
  log: FastifyBaseLogger,
  indexer: IndexerRow,
  response: IndexerSearchResponse,
): void {
  log.debug({
    indexer: indexer.name,
    type: indexer.type,
    ...(response.requestUrl ? { url: sanitizeLogUrl(response.requestUrl) } : {}),
    ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
    itemsObserved: response.parseStats.itemsObserved,
    kept: response.parseStats.kept,
    dropped: response.parseStats.dropped,
  }, 'Indexer search complete');

  for (const trace of response.debugTrace) {
    if (trace.reason !== 'kept') {
      log.debug({
        indexer: indexer.name,
        reason: trace.reason,
        rawTitle: trace.rawTitle,
        rawTitleBytes: trace.rawTitleBytes,
        guid: trace.guid,
      }, 'Indexer dropped item');
    }
  }
}
