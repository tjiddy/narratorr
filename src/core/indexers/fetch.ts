/**
 * Shared fetch utility with optional FlareSolverr/Byparr proxy support.
 *
 * When `proxyUrl` is provided, requests are routed through FlareSolverr's API
 * (POST {proxyUrl}/v1 with cmd: "request.get"). When absent, uses direct fetch.
 */

import { z } from 'zod';

import { mapNetworkError } from '../utils/map-network-error.js';
import {
  createSsrfSafeDispatcher,
  resolveAndValidate,
  SsrfRefusedError,
} from '../utils/blocked-fetch-address.js';
import { readBodyWithCap } from '../utils/read-body-with-cap.js';
import {
  RESPONSE_CAP_FLARESOLVERR,
  RESPONSE_CAP_INDEXER,
} from '../utils/response-caps.js';

import { INDEXER_TIMEOUT_MS, PROXY_TIMEOUT_MS } from '../utils/constants.js';
import { normalizeBaseUrl } from '../../shared/normalize-base-url.js';

const flareSolverrResponseSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  solution: z.object({
    response: z.string().optional(),
    status: z.number().optional(),
    url: z.string().optional(),
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
  // Pre-flight + socket-bound dispatcher prevent SSRF / DNS rebinding for
  // direct (non-FlareSolverr) indexer paths. Returns string to preserve the
  // existing caller contract (Newznab/Torznab/ABB consume it as text).
  const target = new URL(url);
  await resolveAndValidate(target.hostname);
  const dispatcher = createSsrfSafeDispatcher();

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
        dispatcher,
      } as RequestInit & { dispatcher: unknown });
    } catch (error: unknown) {
      if (error instanceof SsrfRefusedError) throw error;
      throw mapNetworkError(error);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => { /* best-effort */ });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const buffer = await readBodyWithCap(response, RESPONSE_CAP_INDEXER);
    return decodeBody(buffer, response.headers.get('content-type'));
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
  // FlareSolverr-specific contract:
  //   - The user-configured proxyUrl (FlareSolverr endpoint) is NOT pre-flighted
  //     and NOT routed through the SSRF-safe dispatcher — local/Docker
  //     deployments (127.0.0.1, RFC 1918, *.local) are the standard config.
  //   - The targetUrl placed in the FlareSolverr request body IS validated —
  //     FlareSolverr fetches it on our behalf, so failing to gate the target
  //     leaves SSRF intact.
  //   - Redirects emitted inside the FlareSolverr envelope (solution.url) are
  //     not auto-followed by our code; we log and return the body verbatim.
  const target = new URL(targetUrl);
  await resolveAndValidate(target.hostname);

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
      // Best-effort drain — fire-and-forget so a slow body stream cannot
      // wedge the error path past the timeout.
      void response.body?.cancel().catch(() => { /* best-effort */ });
      throw new Error(`FlareSolverr proxy HTTP error ${response.status}`);
    }

    return await parseFlareSolverrResponse(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseFlareSolverrResponse(response: Response): Promise<string> {
  // Cap the envelope BEFORE JSON.parse, since FlareSolverr nests the target
  // body inside the envelope. Wrapper-internal cap; callers do not pass it.
  const buffer = await readBodyWithCap(response, RESPONSE_CAP_FLARESOLVERR);
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf-8'));
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
}

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
