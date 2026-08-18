/** Fetch indexer content directly or through a FlareSolverr-compatible proxy. */

import { z } from 'zod';

import { mapNetworkError } from '../utils/map-network-error.js';
import { httpStatusError } from './errors.js';

import { INDEXER_TIMEOUT_MS, PROXY_TIMEOUT_MS } from '../utils/constants.js';
import { acquireSolverSlot } from './solver-concurrency.js';
import { solverEndpoint } from './solver-endpoint.js';
import { markSolverFailure, transportCodeOf } from './solver-failure.js';

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
  /**
   * Awaited as the last thing before this request goes on the wire — on the solver path that means
   * after a slot is held, not before it. A caller pacing a destination must wait here rather than
   * around this call: a wait taken before the slot lets two correctly-spaced requests stall behind
   * a saturated pool and dispatch together the moment slots free (#2420). A rejection propagates
   * verbatim and issues no request, releasing anything already held.
   */
  onBeforeDispatch?: (() => Promise<void>) | undefined;
}

/** Response body plus the target URL and upstream status. */
export interface FetchResult {
  body: string;
  requestUrl: string;
  httpStatus: number;
}

/** Fetch directly or via FlareSolverr while preserving caller cancellation. */
export async function fetchWithProxy(options: FetchWithProxyOptions): Promise<FetchResult> {
  const { url, headers, proxyUrl, onBeforeDispatch } = options;

  if (proxyUrl) {
    return fetchViaProxy(url, headers, proxyUrl, options.timeoutMs ?? PROXY_TIMEOUT_MS, options.signal, onBeforeDispatch);
  }

  // Nothing intervenes on the direct path, so here the hook is simply the last step before the wire.
  if (onBeforeDispatch) await onBeforeDispatch();
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
      throw httpStatusError(response.status, response.statusText);
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
 *
 * `onBeforeDispatch` runs inside that same `try`, so a caller's own wait sits between the slot and
 * the POST and a rejection there still releases the slot through the existing `finally`.
 */
async function fetchViaProxy(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  proxyUrl: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
  onBeforeDispatch?: () => Promise<void>,
): Promise<FetchResult> {
  const releaseSlot = await acquireSolverSlot(proxyUrl, callerSignal);
  try {
    if (onBeforeDispatch) await onBeforeDispatch();
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

  const proxyEndpoint = solverEndpoint(proxyUrl);

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
        // No connection or response milestone is retained, so this arm entails nothing about either
        // component — it is the only one the diagnosis must probe both sides for (#2374).
        throw markSolverFailure(
          new Error(`FlareSolverr proxy timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: error }),
          'round-trip-timeout',
        );
      }
      // One message covers every non-abort rejection, so the retained cause's transport code is the
      // only thing separating "that address refused" from "our own resolver is down".
      const transportCode = transportCodeOf(mapNetworkError(error));
      throw markSolverFailure(
        new Error(`FlareSolverr proxy unreachable at ${proxyUrl}`, { cause: error }),
        'solver-no-answer',
        transportCode,
      );
    }

    if (!response.ok) {
      // A `Response` exists, so something answered at the solver URL — and nothing more than that.
      // The envelope is deliberately not inspected: supported solvers return valid protocol bodies
      // on non-2xx, so a status carries no claim about solver health either way.
      throw markSolverFailure(new Error(`FlareSolverr proxy HTTP error ${response.status}`), 'solver-answered');
    }

    const parsedBody = await parseFlareSolverrResponse(response);
    return { body: parsedBody.body, requestUrl: targetUrl, httpStatus: parsedBody.upstreamStatus };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Every throw here follows a `Response`, so all four carry the `solver-answered` discriminant. */
async function parseFlareSolverrResponse(response: Response): Promise<{ body: string; upstreamStatus: number }> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw markSolverFailure(new Error('FlareSolverr returned invalid response (not JSON)'), 'solver-answered');
  }

  const parsed = flareSolverrResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw markSolverFailure(
      new Error(
        `FlareSolverr returned unexpected response shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      ),
      'solver-answered',
    );
  }
  const data: FlareSolverrResponse = parsed.data;

  if (data.status !== 'ok') {
    throw markSolverFailure(
      new Error(`FlareSolverr error: ${data.message || 'unknown error'}`),
      'solver-answered',
    );
  }

  if (!data.solution?.response) {
    throw markSolverFailure(new Error('FlareSolverr returned empty response'), 'solver-answered');
  }

  return {
    body: data.solution.response,
    upstreamStatus: data.solution.status ?? response.status,
  };
}
