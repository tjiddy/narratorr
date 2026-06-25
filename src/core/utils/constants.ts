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
 * Hard cap on how long `ConnectorService.stop()` waits for in-flight refreshes to
 * drain on graceful shutdown (ms). NOT user-configurable (same status as
 * `CONNECTOR_TIMEOUT_MS`). Sized to leave headroom inside Docker's default 10s
 * stop grace (import-worker stop → connector drain → app.close()) while bounding
 * the pathological case where a large multi-path Plex batch's scaled per-attempt
 * timeout would otherwise block teardown for minutes.
 */
export const CONNECTOR_SHUTDOWN_DRAIN_MS = 5_000;
