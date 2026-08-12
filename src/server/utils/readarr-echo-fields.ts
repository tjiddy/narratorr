// Prowlarr round-trips these fields, but narratorr never consumes them. Strip them
// at route and service boundaries before strict Torznab/Newznab validation.
export const READARR_ECHO_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'categories',
  'minimumSeeders',
  'seedCriteria.seedRatio',
  'seedCriteria.seedTime',
]);

export function stripReadarrEchoOnlyFields(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!READARR_ECHO_ONLY_FIELDS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
