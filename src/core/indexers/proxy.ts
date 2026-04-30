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
import { getErrorMessage } from '../../shared/error-message.js';
import { mapNetworkError } from '../utils/map-network-error.js';
import {
  createSsrfSafeDispatcher,
  resolveAndValidate,
  SsrfRefusedError,
} from '../utils/blocked-fetch-address.js';
import { readBodyWithCap } from '../utils/read-body-with-cap.js';
import { RESPONSE_CAP_INDEXER } from '../utils/response-caps.js';

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
 * Fetch a URL through a proxy agent. SSRF-hardened: pre-flights the *target*
 * hostname against the block policy on every call. When no proxy is set, also
 * attaches a socket-validating dispatcher (DNS rebinding defense). When a proxy
 * is set, the proxy hop is treated as trusted user configuration — only the
 * target is pre-flighted (socket-level validation cannot pass through the proxy).
 *
 * Body is capped at `RESPONSE_CAP_INDEXER` and decoded to text before return —
 * the public `Promise<string>` contract is preserved.
 *
 * Throws ProxyError on transport failures, SsrfRefusedError on policy refusal.
 */
export async function fetchWithProxyAgent(
  url: string,
  options: {
    proxyUrl?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const { proxyUrl, headers, timeoutMs = INDEXER_TIMEOUT_MS } = options;

  // Pre-flight target host — refuses cloud-metadata names and blocked IPs even
  // when traffic is going through a proxy that we trust at the hop level.
  const target = new URL(url);
  await resolveAndValidate(target.hostname);

  const proxyDispatcher = createProxyAgent(proxyUrl);
  // Without a proxy, attach the SSRF-safe dispatcher for socket-level rebinding
  // defense. With a proxy, the connection terminates at the proxy hop — the
  // socket lookup runs against the proxy host, not the target, so the SSRF
  // dispatcher cannot enforce target validation. The pre-flight above is the
  // only target check available in that mode.
  const dispatcher = proxyDispatcher ?? createSsrfSafeDispatcher();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;

  try {
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      headers,
      signal,
      dispatcher,
    };

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error: unknown) {
      if (error instanceof SsrfRefusedError) throw error;
      if (!proxyDispatcher) throw mapNetworkError(error); // Direct fetch — map network errors
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProxyError(`Proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      const msg = getErrorMessage(error);
      throw new ProxyError(`Proxy connection failed: ${msg}`);
    }

    if (!response.ok) {
      if (proxyDispatcher) {
        // Only wrap as ProxyError if it's clearly a proxy-level failure
        // (e.g., 407 Proxy Authentication Required, 502 Bad Gateway from proxy)
        const proxyStatusCodes = [407, 502, 503];
        if (proxyStatusCodes.includes(response.status)) {
          await response.body?.cancel().catch(() => { /* best-effort */ });
          throw new ProxyError(`Proxy HTTP error ${response.status}: ${response.statusText}`);
        }
      }
      await response.body?.cancel().catch(() => { /* best-effort */ });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const buffer = await readBodyWithCap(response, RESPONSE_CAP_INDEXER);
    return decodeBody(buffer, response.headers.get('content-type'));
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Decode a buffered response body to text using the charset from `Content-Type`
 * when present; defaults to UTF-8.
 */
function decodeBody(buffer: Buffer, contentType: string | null): string {
  const charset = parseCharset(contentType);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

function parseCharset(contentType: string | null): string {
  if (!contentType) return 'utf-8';
  const match = contentType.match(/charset=([^;]+)/i);
  return match ? match[1].trim().toLowerCase() : 'utf-8';
}

/**
 * Resolve the exit IP address by making a request through the proxy to ipify.
 * Returns the IP string on success, throws ProxyError on failure.
 */
export async function resolveProxyIp(proxyUrl: string): Promise<string> {
  try {
    const body = await fetchWithProxyAgent(IPIFY_URL, { proxyUrl, timeoutMs: 15_000 });
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
