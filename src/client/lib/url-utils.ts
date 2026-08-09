import { URL_BASE } from './api/client.js';

/** Prefixes app-relative URLs with `URL_BASE`; absolute URLs pass through. */
export function resolveUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!URL_BASE) return url;
  return `${URL_BASE}${url}`;
}

/** Adds an `updatedAt` cache key only to local cover URLs. */
export function resolveCoverUrl(
  url: string | undefined | null,
  updatedAt: string | null | undefined,
): string | undefined {
  const resolved = resolveUrl(url);
  if (!resolved) return undefined;
  if (url!.startsWith('http://') || url!.startsWith('https://')) return resolved;
  if (!updatedAt) return resolved;
  const epoch = Math.floor(new Date(updatedAt).getTime() / 1000);
  return `${resolved}?v=${epoch}`;
}
