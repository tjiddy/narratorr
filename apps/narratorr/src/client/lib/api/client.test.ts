import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchApi, ApiError } from './client';

describe('ApiError', () => {
  it('extracts error message from body.error', () => {
    const err = new ApiError(400, { error: 'Bad request' });
    expect(err.message).toBe('Bad request');
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: 'Bad request' });
  });

  it('extracts error message from body.message', () => {
    const err = new ApiError(500, { message: 'Internal server error' });
    expect(err.message).toBe('Internal server error');
    expect(err.status).toBe(500);
  });

  it('falls back to HTTP status when no message field', () => {
    const err = new ApiError(404, { foo: 'bar' });
    expect(err.message).toBe('HTTP 404');
    expect(err.status).toBe(404);
  });

  it('falls back to HTTP status when body is null', () => {
    const err = new ApiError(502, null);
    expect(err.message).toBe('HTTP 502');
  });

  it('is an instance of Error', () => {
    const err = new ApiError(500, {});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });
});

describe('fetchApi', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('makes GET request and returns parsed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, title: 'Test' }),
    });

    const result = await fetchApi<{ id: number; title: string }>('/books');

    expect(fetch).toHaveBeenCalledWith('/api/books', expect.objectContaining({
      credentials: 'include',
    }));
    expect(result).toEqual({ id: 1, title: 'Test' });
  });

  it('sets Content-Type header when body is provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1 }),
    });

    await fetchApi('/books', {
      method: 'POST',
      body: JSON.stringify({ title: 'New Book' }),
    });

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does NOT set Content-Type when no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await fetchApi('/books');

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws ApiError on non-2xx response with JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Validation failed' }),
    });

    await expect(fetchApi('/books')).rejects.toThrow(ApiError);

    try {
      await fetchApi('/books');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.message).toBe('Validation failed');
      expect(apiErr.body).toEqual({ error: 'Validation failed' });
    }
  });

  it('falls back to HTTP status when error response body is not JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not JSON')),
    });

    try {
      await fetchApi('/books');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).toBe('HTTP 500');
      expect(apiErr.body).toEqual({ error: 'HTTP 500' });
    }

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('includes credentials in every request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await fetchApi('/test');

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].credentials).toBe('include');
  });
});
