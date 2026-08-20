/** Standard HTTP/HTTPS/SOCKS5 proxy transport; FlareSolverr lives in fetch.ts. */

import { z } from 'zod';
import { isIPv6 } from 'node:net';
import { ProxyAgent, Socks5ProxyAgent } from 'undici';
import { ProxyError, httpStatusError } from './errors.js';
import { getErrorMessage, getErrorMessageWithCause } from '@shared/error-message.js';
import { mapNetworkError } from '../utils/map-network-error.js';
import { fetchWithOptionalDispatcher, normalizeHostname, type DispatcherFetchInit } from '../utils/network-service.js';
import type { FetchResult } from './fetch.js';

import { INDEXER_TIMEOUT_MS } from '../utils/constants.js';
const IPIFY_URL = 'https://api.ipify.org?format=json';

const ipifyResponseSchema = z.object({
  ip: z.string(),
}).passthrough();

type ProxyDispatcher = ProxyAgent | Socks5ProxyAgent;

function protocolOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).protocol;
  } catch {
    return undefined;
  }
}

/**
 * undici 8's `Socks5ProxyAgent` hands `new URL(origin).hostname` to its address encoder unchanged,
 * and Node leaves IPv6 hostnames bracketed — so `[::1]` goes out as ATYP 0x03, a *domain name* the
 * proxy then fails to resolve. Refusing beats silently tunnelling to the wrong address. A target
 * that does not parse is not this guard's business.
 */
function isIPv6LiteralTarget(targetUrl: string): boolean {
  try {
    return isIPv6(normalizeHostname(new URL(targetUrl).hostname));
  } catch {
    return false;
  }
}

/**
 * Create a proxy dispatcher, or undefined when no proxy is configured. `targetUrl` is required so
 * the compiler forces every call site to supply what the SOCKS5 guard needs.
 */
export function createProxyAgent(proxyUrl: string | undefined, targetUrl: string): ProxyDispatcher | undefined {
  if (!proxyUrl) return undefined;

  // Outside the try below: its bare catch would rewrite this as the generic "Invalid proxy URL".
  if (protocolOf(proxyUrl) === 'socks5:' && isIPv6LiteralTarget(targetUrl)) {
    throw new ProxyError(
      `SOCKS5 proxies cannot reach IPv6-literal targets: ${new URL(targetUrl).hostname}. ` +
      'Use a hostname or an IPv4 address for this URL, or switch to an HTTP(S) proxy.',
    );
  }

  try {
    const url = new URL(proxyUrl);

    if (url.protocol === 'socks5:') {
      return new Socks5ProxyAgent(proxyUrl);
    }

    return new ProxyAgent(proxyUrl);
  } catch {
    throw new ProxyError(`Invalid proxy URL: ${proxyUrl}`);
  }
}

/** Fetch through an optional proxy agent, preserving upstream HTTP errors. */
export async function fetchWithProxyAgent(
  url: string,
  options: {
    proxyUrl?: string | undefined;
    headers?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<FetchResult> {
  const { proxyUrl, headers, timeoutMs = INDEXER_TIMEOUT_MS } = options;
  const dispatcher = createProxyAgent(proxyUrl, url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const fetchOptions: DispatcherFetchInit = {
      signal,
      ...(headers !== undefined && { headers }),
      ...(dispatcher !== undefined && { dispatcher }),
    };

    let response: Response;
    try {
      response = await fetchWithOptionalDispatcher(url, fetchOptions);
    } catch (error: unknown) {
      if (!dispatcher) throw mapNetworkError(error); // Preserve direct network error mapping.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProxyError(`Proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      const msg = getErrorMessageWithCause(error);
      throw new ProxyError(`Proxy connection failed: ${msg}`);
    }

    if (!response.ok) {
      if (dispatcher) {
        // Only known proxy statuses become ProxyError; upstream errors stay ordinary.
        const proxyStatusCodes = [407, 502, 503];
        if (proxyStatusCodes.includes(response.status)) {
          throw new ProxyError(`Proxy HTTP error ${response.status}: ${response.statusText}`);
        }
      }
      throw httpStatusError(response.status, response.statusText);
    }

    const body = await response.text();
    return { body, requestUrl: url, httpStatus: response.status };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Resolve the proxy's exit IP through ipify. */
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
