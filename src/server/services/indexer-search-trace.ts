import type { FastifyBaseLogger } from 'fastify';
import type { IndexerParseTrace, IndexerSearchResponse } from '@core/index.js';
import type { IndexerRow } from './types.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';

/**
 * The one drop reason an operator cannot see any other way: the row simply vanishes from the
 * results, so this logs at `warn` rather than `debug` (#2367). Same precedent as the multi-part
 * Usenet rejection. The trace property is `requestUrl`; the log key is `url`, which is what the
 * `Indexer search complete` line already calls a sanitized request URL.
 */
function logDetailFetchFailure(log: FastifyBaseLogger, indexerName: string, trace: IndexerParseTrace): void {
  log.warn({
    indexer: indexerName,
    reason: trace.reason,
    rawTitle: trace.rawTitle,
    ...(trace.rawTitleBytes !== undefined && { rawTitleBytes: trace.rawTitleBytes }),
    errorMessage: trace.errorMessage,
    ...(trace.errorCode !== undefined && { errorCode: trace.errorCode }),
    ...(trace.httpStatus !== undefined && { httpStatus: trace.httpStatus }),
    ...(trace.requestUrl !== undefined && { url: sanitizeLogUrl(trace.requestUrl) }),
  }, 'Indexer detail fetch failed');
}

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
    if (trace.reason === 'dropped:detail-fetch-failed') {
      logDetailFetchFailure(log, indexer.name, trace);
    } else if (trace.reason !== 'kept') {
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
