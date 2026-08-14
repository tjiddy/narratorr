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

/**
 * How long one `searchAndGrabForBook` call may hold its caller. Sized above the worst legitimate
 * run (~17.5 min: 8 ladder rungs of refresh+search, usenet enrichment, URL resolution, redirects
 * and the download client's own request graph), because a tighter number aborts searches that were
 * about to succeed against FlareSolverr-proxied indexers. The guarantee is the race, not this
 * arithmetic — the redirect helper's DNS preflight has no timeout of its own to add up.
 * A constant, not a setting: an operator-tunable value invites a too-tight one.
 */
export const SEARCH_DEADLINE_MS = 1_500_000;
