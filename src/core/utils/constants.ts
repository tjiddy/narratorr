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
