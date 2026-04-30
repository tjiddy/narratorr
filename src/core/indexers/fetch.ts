/**
 * Shared fetch utility with optional FlareSolverr/Byparr proxy support.
 *
 * When `proxyUrl` is provided, requests are routed through FlareSolverr's API
 * (POST {proxyUrl}/v1 with cmd: "request.get"). When absent, uses direct fetch.
 */

import { z } from 'zod';

import { mapNetworkError } from '../utils/map-network-error.js';

import { INDEXER_TIMEOUT_MS, PROXY_TIMEOUT_MS } from '../utils/constants.js';
import { normalizeBaseUrl } from '../../shared/normalize-base-url.js';

const flareSolverrResponseSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  solution: z.object({
    response: z.string().optional(),
    status: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

type FlareSolverrResponse = z.infer<typeof flareSolverrResponseSchema>;

export interface FetchWithProxyOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  proxyUrl?: string;
  signal?: AbortSignal;
}

/**
 * Fetch a URL, optionally routing through a FlareSolverr-compatible proxy.
 *
 * - Direct: standard fetch() with AbortController timeout
 * - Proxied: POST to {proxyUrl}/v1 with FlareSolverr request.get command
 *
 * All proxy errors throw with descriptive messages that distinguish proxy
 * failures from indexer failures. Direct fetch errors throw as-is.
 */
export async function fetchWithProxy(options: FetchWithProxyOptions): Promise<string> {
  const { url, headers, proxyUrl } = options;

  if (proxyUrl) {
    return fetchViaProxy(url, headers, proxyUrl, options.timeoutMs ?? PROXY_TIMEOUT_MS, options.signal);
  }

  return fetchDirect(url, headers, options.timeoutMs ?? INDEXER_TIMEOUT_MS, options.signal);
}

async function fetchDirect(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal,
      });
    } catch (error: unknown) {
      throw mapNetworkError(error);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchViaProxy(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  proxyUrl: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;

  const proxyEndpoint = `${normalizeBaseUrl(proxyUrl)}/v1`;

  try {
    const body: Record<string, unknown> = {
      cmd: 'request.get',
      url: targetUrl,
      maxTimeout: timeoutMs,
    };

    if (headers && Object.keys(headers).length > 0) {
      body.headers = headers;
    }

    let response: Response;
    try {
      response = await fetch(proxyEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error: unknown) {
      // Network-level failure reaching the proxy itself
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`FlareSolverr proxy timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: error });
      }
      throw new Error(`FlareSolverr proxy unreachable at ${proxyUrl}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`FlareSolverr proxy HTTP error ${response.status}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error('FlareSolverr returned invalid response (not JSON)');
    }

    const parsed = flareSolverrResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `FlareSolverr returned unexpected response shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    const data: FlareSolverrResponse = parsed.data;

    if (data.status !== 'ok') {
      throw new Error(
        `FlareSolverr error: ${data.message || 'unknown error'}`,
      );
    }

    if (!data.solution?.response) {
      throw new Error('FlareSolverr returned empty response');
    }

    return data.solution.response;
  } finally {
    clearTimeout(timeoutId);
  }
}
