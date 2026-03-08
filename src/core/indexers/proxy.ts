/**
 * Proxy agent creation and IP resolution for HTTP/HTTPS/SOCKS5 proxies.
 *
 * This module provides the standard proxy path (not FlareSolverr).
 * FlareSolverr uses its own API and is handled in fetch.ts.
 */

import { ProxyAgent } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyError } from './errors.js';

const PROXY_TIMEOUT_MS = 30_000;
const IPIFY_URL = 'https://api.ipify.org?format=json';

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
  } = {},
): Promise<string> {
  const { proxyUrl, headers, timeoutMs = PROXY_TIMEOUT_MS } = options;
  const dispatcher = createProxyAgent(proxyUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      headers,
      signal: controller.signal,
    };

    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (!dispatcher) throw error; // Direct fetch — let caller handle
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProxyError(`Proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      const msg = error instanceof Error ? error.message : 'unknown error';
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

    return await response.text();
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
    const body = await fetchWithProxyAgent(IPIFY_URL, { proxyUrl, timeoutMs: 15_000 });
    const data = JSON.parse(body) as { ip?: string };
    if (!data.ip) {
      throw new ProxyError('IP lookup returned empty response');
    }
    return data.ip;
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    const msg = error instanceof Error ? error.message : 'unknown error';
    throw new ProxyError(`Failed to resolve proxy exit IP: ${msg}`);
  }
}
