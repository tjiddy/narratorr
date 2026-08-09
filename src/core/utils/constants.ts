export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export const INDEXER_TIMEOUT_MS = 30_000;

export const PROXY_TIMEOUT_MS = 60_000;

export const NOTIFIER_TIMEOUT_MS = 10_000;

export const IMPORT_LIST_TIMEOUT_MS = 30_000;

export const AUDIBLE_TIMEOUT_MS = 10_000;

export const AUDNEXUS_TIMEOUT_MS = 15_000;

export const HTTP_DOWNLOAD_TIMEOUT_MS = 30_000;

export const HARDCOVER_TIMEOUT_MS = 15_000;

export const CONNECTOR_TIMEOUT_MS = 15_000;

// Must fit inside Docker's 10s stop grace; scaled Plex batch timeouts can otherwise stall teardown for minutes.
export const CONNECTOR_SHUTDOWN_DRAIN_MS = 5_000;
