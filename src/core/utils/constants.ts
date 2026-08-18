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
 * MyAnonamouse's documented minimum interval between requests from one client. A constant, not a
 * setting: MAM is a private tracker with a client whitelist, and an operator-tunable value invites
 * a too-tight one — the same reasoning `SEARCH_DEADLINE_MS` records.
 */
export const MAM_MIN_REQUEST_INTERVAL_MS = 250;

/**
 * AudioBookBay's minimum interval between any two requests from one client. A constant, not a
 * setting, on `MAM_MIN_REQUEST_INTERVAL_MS`'s reasoning — and the value is not ours to pick: Jackett
 * has ratcheted its ABB `requestDelay` against real blocks for years (2.1s -> 3.1s in Feb 2023 after
 * ABB blocked Prowlarr at 2s, -> 5.1s in Dec 2023, -> 6.1s, held through mid-2025). Narratorr's own
 * 2026-08 temp IP ban was earned firing 4-12x hotter than that, so 6.1s is the floor the community's
 * evidence supports and an operator-tunable value would invite a too-tight one.
 */
export const ABB_MIN_REQUEST_INTERVAL_MS = 6_100;

/**
 * How many requests one FlareSolverr-compatible solver may hold at once. A constant, not a setting:
 * it bounds browser memory inside the solver process (byparr allocates one browser per request and
 * budgets ~512MB each, so three is ~1.5GB), and it protects against a failure mode the operator
 * cannot foresee — an operator who raises it to 20 has re-armed the OOM that took a 15.5GiB host
 * down twice on 2026-08-15. Three leaves ABB's serial search-then-detail pattern plus a second
 * indexer unqueued in the healthy case. Same reasoning `MAM_MIN_REQUEST_INTERVAL_MS` records.
 */
export const SOLVER_MAX_CONCURRENT_REQUESTS = 3;

/**
 * How long a solver request may wait for one of those slots before failing. One full
 * `PROXY_TIMEOUT_MS`: a waiter still unadmitted after an occupant's entire budget is queued behind a
 * saturated solver, not behind ordinary traffic. Bounded rather than indefinite because an unbounded
 * queue converts memory exhaustion into a stalled search pipeline — better, still a hang. Worst case
 * is one wait per ladder rung (~8 min at `MAX_SEARCH_RUNGS`), inside `SEARCH_DEADLINE_MS`.
 */
export const SOLVER_SLOT_WAIT_TIMEOUT_MS = 60_000;

/**
 * How long each connection-test reachability probe may wait for anything to answer. ONE value for
 * both the target and the solver probe, not one each: they run concurrently, so a single budget is
 * the whole diagnosis's added cost, and a second value would make that arithmetic false. Far below
 * `PROXY_TIMEOUT_MS` because the probe only asks whether an HTTP listener is there — it runs on a
 * test that has already failed, so a slow answer is worth less to the operator than a fast verdict,
 * and an expiry is `inconclusive` rather than a culprit (#2374).
 */
export const REACHABILITY_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long one `searchAndGrabForBook` call may hold its caller. Sized above the worst legitimate
 * run (~17.5 min: 8 ladder rungs of refresh+search, usenet enrichment, URL resolution, redirects
 * and the download client's own request graph), because a tighter number aborts searches that were
 * about to succeed against FlareSolverr-proxied indexers. The guarantee is the race, not this
 * arithmetic — the redirect helper's DNS preflight has no timeout of its own to add up.
 * A constant, not a setting: an operator-tunable value invites a too-tight one.
 */
export const SEARCH_DEADLINE_MS = 1_500_000;
