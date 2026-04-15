/**
 * Sanitize a download URL for safe logging.
 *
 * Contract:
 * - http/https → origin + pathname only (strip search params and hash)
 * - data: → 'data:application/x-bittorrent [resolved]'
 * - magnet: → 'magnet:[infoHash]' or 'magnet:[unknown]'
 * - anything else → returned as-is
 */
export function sanitizeLogUrl(raw: string): string {
  if (!raw) return raw;

  if (raw.startsWith('data:')) {
    return 'data:application/x-bittorrent [resolved]';
  }

  if (raw.startsWith('magnet:')) {
    const match = raw.match(/xt=urn(?::|%3A)btih(?::|%3A)([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
    return match ? `magnet:[${match[1].toLowerCase()}]` : 'magnet:[unknown]';
  }

  try {
    const url = new URL(raw);
    // Strip search + hash to prevent credential/token leaks in logs
    return url.origin + url.pathname;
  } catch {
    // Malformed/non-URL strings that fail new URL() are returned as-is intentionally
    return raw;
  }
}
