declare global {
  interface Window {
    __NARRATORR_URL_BASE__?: string;
  }
}

/** URL_BASE prefix injected by the server at runtime. Empty string when at root. */
export const URL_BASE = typeof window !== 'undefined' ? (window.__NARRATORR_URL_BASE__ ?? '') : '';

const API_BASE = `${URL_BASE}/api`;

export class ApiError extends Error {
  status: number;
  body: unknown;
  /**
   * Parsed `Retry-After` delay in ms-from-now (#1893). Present only when the
   * response carried a valid `Retry-After` header (delta-seconds or a future
   * HTTP-date); the staged-import retry helper honors it (clamped to a cap).
   * Optional so existing two-arg `new ApiError(status, body)` callers are
   * unaffected.
   */
  retryAfterMs?: number | undefined;
  constructor(status: number, body: unknown, retryAfterMs?: number) {
    const message = (body as { error?: string })?.error
      || (body as { message?: string })?.message
      || `HTTP ${status}`;
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse a `Retry-After` header value to a delay in ms from `nowMs`. Accepts the
 * two RFC-7231 forms — non-negative delta-seconds, or an HTTP-date — and returns
 * `undefined` for an absent, empty, malformed, or already-past value (#1893).
 */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number = Date.now()): number | undefined {
  if (headerValue == null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000; // non-negative delta-seconds
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : undefined; // a past HTTP-date is not a retry hint
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  const error = await response.json().catch((parseError) => {
    console.warn('Failed to parse error response body:', parseError);
    return { error: `HTTP ${response.status}` };
  });
  throw new ApiError(response.status, error, parseRetryAfterMs(response.headers?.get?.('retry-after') ?? null));
}

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
    ...(options?.headers as Record<string, string>),
  };

  // Only set Content-Type for requests with a body
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  await throwIfNotOk(response);
  return response.json();
}

export async function fetchMultipart<T>(
  path: string,
  body: FormData,
  options?: Omit<RequestInit, 'body' | 'method'> & { method?: 'POST' | 'PUT' | 'PATCH' },
): Promise<T> {
  // Normalize via Headers so all HeadersInit shapes (Headers, tuple arrays, plain objects)
  // are merged correctly. Defaults are seeded first; caller headers overwrite them.
  const headers = new Headers({ 'X-Requested-With': 'XMLHttpRequest' });
  if (options?.headers) {
    new Headers(options.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    method: options?.method ?? 'POST',
    body,
    headers,
    credentials: 'include',
  });

  await throwIfNotOk(response);
  return response.json();
}
