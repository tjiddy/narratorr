/**
 * Single source of truth for the app version tag.
 *
 * Applies the build-injected `GIT_TAG` → `"dev"` fallback (also for the
 * sentinel `"unknown"`) AND a header-safe sanitization pass: any character
 * outside the HTTP token-ish set `[\w.+-]` is stripped, so a tag containing a
 * space, CR/LF, or unicode can never produce an invalid `User-Agent` value
 * that makes undici throw at request time. When sanitization empties the tag,
 * it falls back to `"dev"`.
 *
 * Lives in `src/shared` so both `getUserAgent()` (here) and `getVersion()`
 * (`src/server/utils/version.ts`) consume it — they can never diverge, even
 * for an unsafe tag. Core cannot import server (eslint layering guard), so the
 * resolver cannot live alongside `getVersion()`.
 *
 * For normal semver tags (only `\w`, `.`, `+`, `-`) sanitization is a no-op,
 * so existing behavior is unchanged; only genuinely malformed tags normalize.
 */
export function resolveVersionTag(): string {
  const tag = process.env.GIT_TAG;
  if (!tag || tag === 'unknown') return 'dev';
  const sanitized = tag.replace(/[^\w.+-]/g, '');
  return sanitized || 'dev';
}

/**
 * Canonical outbound User-Agent for indexer-facing fetches: `Narratorr/<version>`.
 *
 * Used by core adapters (blackhole self-download, newznab/torznab API calls,
 * MAM `.torrent` grab, HTTP torrent artifact grab) and server utils (Usenet
 * language enrichment). Derives its version from {@link resolveVersionTag} so
 * it always agrees with the app version reported by `getVersion()`.
 */
export function getUserAgent(): string {
  return `Narratorr/${resolveVersionTag()}`;
}
