/**
 * Redirect-following SSRF-hardened fetch helper.
 *
 * Used by callers whose upstream commonly issues 302→final-artifact (e.g.,
 * Newznab/Torznab `getnzb` endpoints) and where the default redirect-rejecting
 * `fetchWithTimeout` would prematurely fail. Mirrors the cover-download
 * pattern: preflight + SSRF-safe dispatcher + manual redirect loop with
 * per-hop revalidation + streamed response cap.
 *
 * Returns the body as a `Buffer`. Caller decodes (or treats as binary).
 */
import { HTTP_DOWNLOAD_TIMEOUT_MS } from './constants.js';
import {
  createSsrfSafeDispatcher,
  resolveAndValidate,
} from './blocked-fetch-address.js';
import { readBodyWithCap } from './read-body-with-cap.js';

const MAX_REDIRECTS = 5;

export interface FetchFollowingRedirectsOptions {
  /** Streamed response-size cap. */
  maxBodyBytes: number;
  /** Per-attempt timeout. Defaults to `HTTP_DOWNLOAD_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Custom request headers. */
  headers?: Record<string, string>;
  /** Optional caller-supplied abort signal. */
  signal?: AbortSignal;
}

export async function fetchFollowingRedirects(
  url: string,
  options: FetchFollowingRedirectsOptions,
): Promise<{ buffer: Buffer; finalUrl: string; status: number; headers: Headers }> {
  const { maxBodyBytes, timeoutMs = HTTP_DOWNLOAD_TIMEOUT_MS, headers, signal } = options;

  const dispatcher = createSsrfSafeDispatcher();
  const visited = new Set<string>();
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (visited.has(currentUrl)) {
      throw new Error('Redirect loop detected');
    }
    visited.add(currentUrl);

    const target = new URL(currentUrl);
    await resolveAndValidate(target.hostname);

    const init: RequestInit & { dispatcher: unknown } = {
      headers,
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(timeoutMs),
      dispatcher,
    };

    const response = await fetch(currentUrl, init);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        await response.body?.cancel().catch(() => { /* best-effort */ });
        throw new Error('Redirect with no location header');
      }
      const nextUrl = new URL(location, currentUrl).href;
      if (!nextUrl.startsWith('http://') && !nextUrl.startsWith('https://')) {
        await response.body?.cancel().catch(() => { /* best-effort */ });
        throw new Error(`Redirect to unsupported scheme: ${nextUrl.split(':')[0]}:`);
      }
      await response.body?.cancel().catch(() => { /* best-effort */ });
      currentUrl = nextUrl;
      continue;
    }

    const buffer = await readBodyWithCap(response, maxBodyBytes);
    return { buffer, finalUrl: currentUrl, status: response.status, headers: response.headers };
  }

  throw new Error('Too many redirects');
}
