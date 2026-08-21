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

/**
 * The error a proxied fetch's failure should surface, shared by the three call sites that route a
 * request through a dispatcher (here and both MAM helpers). Returns rather than throws so the
 * caller's `throw` keeps the stack at the failing site.
 *
 * `callerSignal` must be the CALLER's signal, never the composed one handed to fetch: that one is
 * aborted by the internal timeout too, so keying on it would reclassify every expiry as a
 * cancellation. Nothing here reads the error's name, message or class to decide *cancellation* —
 * one abort arrives as an `AbortError` DOMException, a custom reason, or whatever the deadline
 * forwarded, and only the signal distinguishes all three from a genuine failure.
 */
export function classifyProxiedFetchError(
  error: unknown,
  options: {
    dispatcher: ProxyDispatcher | undefined;
    timeoutMs: number;
    callerSignal?: AbortSignal | undefined;
    /** The direct (no-dispatcher) arm's mapping; omitted where the site rethrows unmapped. */
    mapDirectError?: ((error: unknown) => unknown) | undefined;
  },
): unknown {
  if (options.callerSignal?.aborted) return error;
  if (!options.dispatcher) return options.mapDirectError ? options.mapDirectError(error) : error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ProxyError(`Proxy timed out after ${Math.round(options.timeoutMs / 1000)}s`);
  }
  return new ProxyError(`Proxy connection failed: ${getErrorMessageWithCause(error)}`);
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
      throw classifyProxiedFetchError(error, {
        dispatcher,
        timeoutMs,
        callerSignal: options.signal,
        mapDirectError: mapNetworkError,
      });
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
