/**
 * Readarr/Prowlarr echo-only indexer fields.
 *
 * Prowlarr (impersonating a Readarr client) sends — and narratorr advertises in
 * its `GET /api/v1/indexer/schema` template — a handful of Torznab/Newznab
 * settings fields that narratorr never consumes at runtime: `categories`,
 * `minimumSeeders`, and the `seedCriteria.*` pair. They exist purely so the
 * Readarr echo surface round-trips; narratorr reads only `apiUrl`/`apiKey`
 * (plus optional proxy fields) from a Torznab/Newznab indexer.
 *
 * These keys must never reach the strict `torznabSettingsSchema` /
 * `newznabSettingsSchema` (which reject unknown keys) during adapter
 * construction, so they are stripped at the Prowlarr-compat translation
 * boundary (route) and again from merged settings on POST upsert (service),
 * which is why this set lives in a shared util both layers can import without
 * inverting the route → service dependency direction.
 */
export const READARR_ECHO_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'categories',
  'minimumSeeders',
  'seedCriteria.seedRatio',
  'seedCriteria.seedTime',
]);

/** Return a copy of `settings` with every Readarr echo-only key removed. */
export function stripReadarrEchoOnlyFields(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!READARR_ECHO_ONLY_FIELDS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
