/**
 * Normalize a series name (or member title) for cache-row dedupe.
 * Lowercased, ASCII alphanumeric runs separated by single spaces.
 */
export function normalizeSeriesName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
