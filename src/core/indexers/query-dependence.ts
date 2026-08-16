/**
 * "Does the query matter to this failure?" — the axis a query-relaxation ladder needs (#2375).
 *
 * A transport failure means the indexer never looked at the query, so re-asking it with a
 * relaxed one is pure amplification; a query-scoped failure may genuinely be this rung's fault
 * and the next rung may well succeed. The verdict is run-scoped: it decides whether an indexer
 * stays eligible for later rungs of ONE ladder run, and says nothing about cross-run backoff,
 * which is the circuit breaker's (#2376).
 */
import { describeTransportError } from '../utils/failure-classification.js';
import { IndexerAuthError, IndexerError, ProxyError, httpStatusOf } from './errors.js';

export type QueryDependence = 'transport' | 'query-scoped';

/**
 * The one code in `map-network-error.ts`'s table the query itself caused: an oversized response
 * means the query was too broad, and narrowing it is precisely what the next rung does.
 */
const OVERSIZED_RESPONSE_CODE = 'UND_ERR_RESPONSE_EXCEEDED_SIZE';

/** Codes that mean the exchange broke. `mapNetworkError` preserves all of them since #2312. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Exactly the statuses a different query can clear. Every other status — 401/403/404/408, 429,
 * and all 5xx — is per-client or per-server: 429 in particular is a rate limit, so relaxing the
 * query cannot clear it and re-asking once per rung is the amplification this axis removes.
 */
const QUERY_SCOPED_STATUSES = new Set([400, 413, 414, 422]);

/**
 * A total order, first match wins. Only a leg whose outcome is a genuine failure reaches here:
 * cancelled, breaker-suppressed and policy-refused legs are decided structurally upstream.
 *
 * **Precedence is code-before-status, deliberately inverting `classifyFailure`'s
 * status-before-code order** (`../utils/failure-classification.ts`). The two answer different
 * questions: `classifyFailure` asks "will a retry ever work", where the server's own status is
 * the authoritative verdict; this asks "does the query matter", where evidence that the exchange
 * itself broke dominates a status that may have been attached further up the wrapper chain.
 *
 * The unrecognized default is `transport`, and the asymmetry is the point: misclassifying a
 * query error costs one book one indexer for one run, while misclassifying a transport error
 * reproduces the eight-fold amplification #2375 exists to remove.
 */
export function classifyQueryDependence(error: unknown): QueryDependence {
  if (error instanceof IndexerAuthError) return 'transport';
  if (error instanceof ProxyError) return 'transport';

  const code = describeTransportError(error).errorCode;
  if (code === OVERSIZED_RESPONSE_CODE) return 'query-scoped';
  if (code !== undefined && TRANSPORT_CODES.has(code)) return 'transport';

  const status = httpStatusOf(error);
  if (status !== undefined) return QUERY_SCOPED_STATUSES.has(status) ? 'query-scoped' : 'transport';

  if (error instanceof IndexerError) return 'query-scoped';
  return 'transport';
}
