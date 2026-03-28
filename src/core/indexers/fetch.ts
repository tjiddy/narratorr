/**
 * Shared fetch utility with optional FlareSolverr/Byparr proxy support.
 *
 * When `proxyUrl` is provided, requests are routed through FlareSolverr's API
 * (POST {proxyUrl}/v1 with cmd: "request.get"). When absent, uses direct fetch.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const PROXY_TIMEOUT_MS = 60_000;

export interface FetchWithProxyOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  proxyUrl?: string;
}

interface FlareSolverrResponse {
  status: string;
  message?: string;
  solution?: {
    response?: string;
    status?: number;
  };
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
    return fetchViaProxy(url, headers, proxyUrl, options.timeoutMs ?? PROXY_TIMEOUT_MS);
  }

  return fetchDirect(url, headers, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

async function fetchDirect(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

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
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const proxyEndpoint = `${proxyUrl.replace(/\/+$/, '')}/v1`;

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
        signal: controller.signal,
      });
    } catch (error: unknown) {
      // Network-level failure reaching the proxy itself
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`FlareSolverr proxy timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new Error(`FlareSolverr proxy unreachable at ${proxyUrl}`);
    }

    if (!response.ok) {
      throw new Error(`FlareSolverr proxy HTTP error ${response.status}`);
    }

    let data: FlareSolverrResponse;
    try {
      data = await response.json() as FlareSolverrResponse;
    } catch {
      throw new Error('FlareSolverr returned invalid response (not JSON)');
    }

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
