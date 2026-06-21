/**
 * Single source of truth for the subpath (reverse-proxy) E2E topology.
 *
 * Both `playwright.config.ts` (server env + project baseURL + health-check URL)
 * and the subpath smoke spec import these so the prefix, port, and base URL stay
 * in sync — there is exactly one place to change the subpath value. The spec
 * cannot import `playwright.config.ts` directly (importing it re-runs
 * `createRunTempDirs()` as an import side effect in the worker process), so the
 * shared constants live in this side-effect-free module instead.
 */

/** Named run key for the subpath server's isolated temp dirs (see temp-dirs.ts). */
export const SUBPATH_RUN = 'subpath';

/** Root server port — the existing `URL_BASE=/` topology, unchanged. */
export const ROOT_PORT = 3100;

/** Subpath server port — the new `URL_BASE=/narratorr` topology. */
export const SUBPATH_PORT = 3101;

/** The reverse-proxy subpath the second server mounts under. */
export const URL_BASE_SUBPATH = '/narratorr';

/**
 * Per-project Playwright `baseURL` for the subpath server. The TRAILING SLASH is
 * load-bearing: Playwright resolves navigation with `new URL(path, baseURL)`, so
 * a relative path (`page.goto('library')`) resolves under the prefix
 * (`.../narratorr/library`) while a leading-slash path is origin-rooted and
 * strips the prefix (`.../library`). In-scope app routes MUST be navigated as
 * relative paths; leading-slash requests are reserved for the deliberate
 * non-prefixed 404 check.
 */
export const SUBPATH_BASE_URL = `http://localhost:${SUBPATH_PORT}${URL_BASE_SUBPATH}/`;
