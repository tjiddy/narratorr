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
