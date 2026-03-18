/**
 * Fetch with an automatic timeout via AbortSignal.timeout().
 * Replaces manual AbortController + setTimeout boilerplate.
 */
export function fetchWithTimeout(
  url: string | URL,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
