/** Fetch indexer content directly or through a FlareSolverr-compatible proxy. */

import { z } from 'zod';

import { mapNetworkError } from '../utils/map-network-error.js';

import { INDEXER_TIMEOUT_MS, PROXY_TIMEOUT_MS } from '../utils/constants.js';
import { acquireSolverSlot } from './solver-concurrency.js';
import { normalizeBaseUrl } from '@shared/normalize-base-url.js';

const flareSolverrResponseSchema = z.object({
  status: z.string(),
  message: z.string().nullish(),
  solution: z.object({
    response: z.string().nullish(),
    status: z.number().nullish(),
  }).passthrough().nullish(),
}).passthrough();

type FlareSolverrResponse = z.infer<typeof flareSolverrResponseSchema>;

export interface FetchWithProxyOptions {
  url: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  proxyUrl?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Response body plus the target URL and upstream status. */
export interface FetchResult {
  body: string;
  requestUrl: string;
  httpStatus: number;
}

/** Fetch directly or via FlareSolverr while preserving caller cancellation. */
export async function fetchWithProxy(options: FetchWithProxyOptions): Promise<FetchResult> {
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
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        ...(headers !== undefined && { headers }),
        signal,
      });
    } catch (error: unknown) {
      throw mapNetworkError(error);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const body = await response.text();
    return { body, requestUrl: url, httpStatus: response.status };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Every solver-bound request in the process funnels through here, so this is where the concurrency
 * bound belongs. The slot is taken before the request timer is armed — acquiring inside that window
 * would hand a request that waited 55s for a slot a 5s solver budget — and released in the `finally`
 * below, after the body has been read and parsed. A leaked slot permanently shrinks the pool and is
 * strictly worse than no bound at all, because it fails closed and silently.
 */
async function fetchViaProxy(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  proxyUrl: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<FetchResult> {
  const releaseSlot = await acquireSolverSlot(proxyUrl, callerSignal);
  try {
    return await postToSolver(targetUrl, headers, proxyUrl, timeoutMs, callerSignal);
  } finally {
    releaseSlot();
  }
}

async function postToSolver(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  proxyUrl: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<FetchResult> {
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
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`FlareSolverr proxy timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: error });
      }
      throw new Error(`FlareSolverr proxy unreachable at ${proxyUrl}`, { cause: error });
    }

    if (!response.ok) {
      throw new Error(`FlareSolverr proxy HTTP error ${response.status}`);
    }

    const parsedBody = await parseFlareSolverrResponse(response);
    return { body: parsedBody.body, requestUrl: targetUrl, httpStatus: parsedBody.upstreamStatus };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseFlareSolverrResponse(response: Response): Promise<{ body: string; upstreamStatus: number }> {
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

  return {
    body: data.solution.response,
    upstreamStatus: data.solution.status ?? response.status,
  };
}
