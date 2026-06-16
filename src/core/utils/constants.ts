/** Default request timeout for download client adapters (ms). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Request timeout for indexer adapters — higher than download clients due to search latency (ms). */
export const INDEXER_TIMEOUT_MS = 30_000;

/** Request timeout for proxy-routed indexer requests — doubled to account for proxy hop (ms). */
export const PROXY_TIMEOUT_MS = 60_000;

/** Request timeout for notifier adapters (ms). */
export const NOTIFIER_TIMEOUT_MS = 10_000;

/** Request timeout for import-list provider adapters (ms). */
export const IMPORT_LIST_TIMEOUT_MS = 30_000;

/** Request timeout for Audible metadata API (ms). */
export const AUDIBLE_TIMEOUT_MS = 10_000;

/** Request timeout for Audnexus metadata API (ms). */
export const AUDNEXUS_TIMEOUT_MS = 15_000;

/** Request timeout for HTTP file downloads — cover images, NZB files via blackhole (ms). */
export const HTTP_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Request timeout for Hardcover series-card GraphQL requests (ms). */
export const HARDCOVER_TIMEOUT_MS = 15_000;

/** Request timeout for a single connector HTTP request (ms). */
export const CONNECTOR_TIMEOUT_MS = 15_000;

/**
 * Request timeout for an earwitness attribution analysis call (ms). Minute-scale
 * on purpose — a single analysis runs CPU-bound Whisper transcription + LLM
 * extraction and can legitimately take minutes, far longer than the 15s metadata
 * timeouts. Overridable per call via `analyzeAttribution`'s `timeoutMs`.
 */
export const EARWITNESS_ATTRIBUTION_TIMEOUT_MS = 300_000;

/**
 * Max attempts beyond the first for the attribution adapter's dedicated 503
 * retry loop. `EARWITNESS_ATTRIBUTION_MAX_RETRIES + 1` total requests are made
 * before a saturated/transient earwitness yields a `transient_failure`.
 */
export const EARWITNESS_ATTRIBUTION_MAX_RETRIES = 2;

/**
 * Fallback backoff before retrying a 503 when the response carries no usable
 * `Retry-After` header (missing/blank/non-numeric) — keeps the delay off `NaN`.
 */
export const EARWITNESS_ATTRIBUTION_DEFAULT_BACKOFF_MS = 2_000;

/**
 * Upper clamp on a server-supplied `Retry-After` so a hostile/buggy earwitness
 * cannot pin the adapter in a multi-minute sleep between retries.
 */
export const EARWITNESS_ATTRIBUTION_MAX_BACKOFF_MS = 30_000;

/**
 * Hard cap on how long `ConnectorService.stop()` waits for in-flight refreshes to
 * drain on graceful shutdown (ms). NOT user-configurable (same status as
 * `CONNECTOR_TIMEOUT_MS`). Sized to leave headroom inside Docker's default 10s
 * stop grace (import-worker stop → connector drain → app.close()) while bounding
 * the pathological case where a large multi-path Plex batch's scaled per-attempt
 * timeout would otherwise block teardown for minutes.
 */
export const CONNECTOR_SHUTDOWN_DRAIN_MS = 5_000;
