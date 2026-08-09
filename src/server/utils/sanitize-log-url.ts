/** Sanitizes a download URL for safe logging: strips query/hash from web URLs, summarizes data/magnet URLs, and returns anything else as-is. */
export function sanitizeLogUrl(raw: string): string {
  if (!raw) return raw;

  if (raw.startsWith('data:')) {
    return 'data:application/x-bittorrent [resolved]';
  }

  if (raw.startsWith('magnet:')) {
    const match = raw.match(/xt=urn(?::|%3A)btih(?::|%3A)([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
    return match ? `magnet:[${match[1]!.toLowerCase()}]` : 'magnet:[unknown]';
  }

  // Parse relative request URLs against a synthetic base, then return only pathname.
  // Gate on '/' so malformed bare strings retain pass-through semantics.
  if (raw.startsWith('/')) {
    try {
      return new URL(raw, 'http://_local').pathname;
    } catch {
      return raw;
    }
  }

  try {
    const url = new URL(raw);
    return url.origin + url.pathname;
  } catch {
    return raw;
  }
}
