export function normalizeBaseUrl(url: string): string;
export function normalizeBaseUrl(url: undefined): undefined;
export function normalizeBaseUrl(url: string | undefined): string | undefined;
export function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  return url.replace(/\/+$/, '');
}
