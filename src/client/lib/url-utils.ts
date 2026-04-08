import { URL_BASE } from './api/client.js';

/**
 * Prepends URL_BASE to app-relative paths (starting with /).
 * Leaves absolute URLs (http://, https://) unchanged.
 * Browser/UI-only — server-side consumers use raw stored values as-is.
 */
export function resolveUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (!URL_BASE) return url;
  return `${URL_BASE}${url}`;
}

/**
 * Resolves a cover URL with cache-busting for local covers.
 * Appends `?v=<epoch>` derived from `updatedAt` so the browser
 * refetches when the cover changes. External URLs pass through unchanged.
 */
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
