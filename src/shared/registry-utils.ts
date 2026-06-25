/**
 * Extract the hostname from a URL setting for display in a card subtitle,
 * falling back to a type label when the value is empty or unparseable.
 *
 * Used by entity-type registries (`viewSubtitle`) to render a human-friendly
 * host without echoing the raw value. Because a masked secret sentinel
 * (`'********'`) is not a parseable URL, secret-backed URL fields degrade
 * safely to the fallback rather than leaking the sentinel into the card.
 */
export function extractHostname(url: string, fallback: string): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
}
