/**
 * Proxy agent creation and IP resolution for HTTP/HTTPS/SOCKS5 proxies.
 *
 * This module provides the standard proxy path (not FlareSolverr).
 * FlareSolverr uses its own API and is handled in fetch.ts.
 */

import { z } from 'zod';
import { ProxyAgent } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyError } from './errors.js';
import { getErrorMessage, getErrorMessageWithCause } from '../../shared/error-message.js';
import { mapNetworkError } from '../utils/map-network-error.js';
import { fetchWithOptionalDispatcher, type DispatcherFetchInit } from '../utils/network-service.js';
import type { FetchResult } from './fetch.js';

import { INDEXER_TIMEOUT_MS } from '../utils/constants.js';
const IPIFY_URL = 'https://api.ipify.org?format=json';

const ipifyResponseSchema = z.object({
  ip: z.string(),
}).passthrough();

type ProxyDispatcher = ProxyAgent | SocksProxyAgent;

/**
 * Create a proxy dispatcher for the given URL.
 * Returns undefined if proxyUrl is empty/undefined.
 */
export function createProxyAgent(proxyUrl: string | undefined): ProxyDispatcher | undefined {
  if (!proxyUrl) return undefined;

  try {
    const url = new URL(proxyUrl);

    if (url.protocol === 'socks5:') {
      return new SocksProxyAgent(proxyUrl);
    }

    // HTTP/HTTPS proxy — use undici ProxyAgent
    return new ProxyAgent(proxyUrl);
  } catch {
    throw new ProxyError(`Invalid proxy URL: ${proxyUrl}`);
  }
}

/**
 * Fetch a URL through a proxy agent. Throws ProxyError on transport failures.
 */
export async function fetchWithProxyAgent(
  url: string,
  options: {
    proxyUrl?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FetchResult> {
  const { proxyUrl, headers, timeoutMs = INDEXER_TIMEOUT_MS } = options;
  const dispatcher = createProxyAgent(proxyUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const fetchOptions: DispatcherFetchInit = {
      headers,
      signal,
      dispatcher,
    };

    let response: Response;
    try {
      response = await fetchWithOptionalDispatcher(url, fetchOptions);
    } catch (error: unknown) {
      if (!dispatcher) throw mapNetworkError(error); // Direct fetch — map network errors
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProxyError(`Proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      const msg = getErrorMessageWithCause(error);
      throw new ProxyError(`Proxy connection failed: ${msg}`);
    }

    if (!response.ok) {
      if (dispatcher) {
        // Only wrap as ProxyError if it's clearly a proxy-level failure
        // (e.g., 407 Proxy Authentication Required, 502 Bad Gateway from proxy)
        const proxyStatusCodes = [407, 502, 503];
        if (proxyStatusCodes.includes(response.status)) {
          throw new ProxyError(`Proxy HTTP error ${response.status}: ${response.statusText}`);
        }
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const body = await response.text();
    return { body, requestUrl: url, httpStatus: response.status };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve the exit IP address by making a request through the proxy to ipify.
 * Returns the IP string on success, throws ProxyError on failure.
 */
export async function resolveProxyIp(proxyUrl: string): Promise<string> {
  try {
    const { body } = await fetchWithProxyAgent(IPIFY_URL, { proxyUrl, timeoutMs: 15_000 });
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (err) {
      throw new ProxyError('IP lookup returned non-JSON response', { cause: err instanceof Error ? err : undefined });
    }
    const parsed = ipifyResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProxyError(
        `IP lookup returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    return parsed.data.ip;
  } catch (error: unknown) {
    if (error instanceof ProxyError) throw error;
    const msg = getErrorMessage(error);
    throw new ProxyError(`Failed to resolve proxy exit IP: ${msg}`);
  }
}
