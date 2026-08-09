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
   * Valid Retry-After delay in milliseconds from now, parsed from delta-seconds
   * or a future HTTP-date.
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

/** Parse Retry-After delta-seconds or HTTP-date; invalid and past values are omitted. */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number = Date.now()): number | undefined {
  if (headerValue == null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : undefined;
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
  // Headers normalizes every HeadersInit shape; caller values override defaults.
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
