/**
 * Canonical outbound User-Agent for indexer-facing fetches: `Narratorr/<version>`.
 *
 * Lives in `src/shared` so both core adapters (blackhole self-download,
 * newznab/torznab API calls) and server utils (Usenet language enrichment)
 * share one identity string — core cannot import server (eslint layering
 * guard), so the helper cannot live alongside `getVersion()` in
 * `src/server/utils/version.ts`.
 *
 * Version resolution mirrors that `getVersion()`: the build-injected `GIT_TAG`,
 * or `"dev"` when the tag is absent or `"unknown"`.
 */
export function getUserAgent(): string {
  const tag = process.env.GIT_TAG;
  const version = tag && tag !== 'unknown' ? tag : 'dev';
  return `Narratorr/${version}`;
}
