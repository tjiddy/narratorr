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
  constructor(status: number, body: unknown) {
    const message = (body as { error?: string })?.error
      || (body as { message?: string })?.message
      || `HTTP ${status}`;
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
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

  if (!response.ok) {
    const error = await response.json().catch((parseError) => {
      console.warn('Failed to parse error response body:', parseError);
      return { error: `HTTP ${response.status}` };
    });
    throw new ApiError(response.status, error);
  }

  return response.json();
}
