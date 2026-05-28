/**
 * Sanitize a download URL for safe logging.
 *
 * Contract:
 * - http/https → origin + pathname only (strip search params and hash)
 * - data: → 'data:application/x-bittorrent [resolved]'
 * - magnet: → 'magnet:[infoHash]' or 'magnet:[unknown]'
 * - relative request paths ('/...') → pathname only (strip search + hash)
 * - anything else → returned as-is
 */
export function sanitizeLogUrl(raw: string): string {
  if (!raw) return raw;

  if (raw.startsWith('data:')) {
    return 'data:application/x-bittorrent [resolved]';
  }

  if (raw.startsWith('magnet:')) {
    const match = raw.match(/xt=urn(?::|%3A)btih(?::|%3A)([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
    return match ? `magnet:[${match[1]!.toLowerCase()}]` : 'magnet:[unknown]';
  }

  // Relative request paths (Fastify request.url, e.g. '/api/search?apikey=secret').
  // `new URL(raw)` throws on these, so parse against a synthetic, non-routable base
  // and return PATHNAME ONLY — the synthetic origin must never leak into logs.
  // Gated on '/' so bare malformed strings ('not-a-url') keep their existing
  // returned-as-is contract instead of being parsed as relative paths.
  if (raw.startsWith('/')) {
    try {
      return new URL(raw, 'http://_local').pathname;
    } catch {
      return raw;
    }
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
