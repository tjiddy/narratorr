import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchApi, fetchMultipart, ApiError, URL_BASE } from './client';

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

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does NOT set Content-Type when no body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await fetchApi('/books');

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers;
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
    } catch (error: unknown) {
      const apiErr = error as ApiError;
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
    } catch (error: unknown) {
      const apiErr = error as ApiError;
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

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].credentials).toBe('include');
  });

  describe('X-Requested-With header (CSRF)', () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      it(`${method} request includes X-Requested-With: XMLHttpRequest`, async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        });

        const opts: RequestInit = method === 'GET' ? {} : { method, body: JSON.stringify({ x: 1 }) };
        await fetchApi('/test', opts);

        const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers;
        expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
      });
    }

    it('caller-supplied headers override defaults but X-Requested-With is preserved when not overridden', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchApi('/test', { headers: { 'X-Custom': 'yes' } });

      const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers;
      expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
      expect(headers['X-Custom']).toBe('yes');
    });
  });
});

describe('fetchApi with URL_BASE', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete window.__NARRATORR_URL_BASE__;
    vi.resetModules();
  });

  it('prepends URL_BASE to API requests when set', async () => {
    // Set URL_BASE on window and force fresh module import
    window.__NARRATORR_URL_BASE__ = '/narratorr';
    vi.resetModules();
    const { fetchApi: prefixedFetchApi } = await import('./client.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    await prefixedFetchApi('/books');

    expect(fetch).toHaveBeenCalledWith(
      '/narratorr/api/books',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('exports URL_BASE from window injection', () => {
    // In test env, window.__NARRATORR_URL_BASE__ is undefined → URL_BASE defaults to ''
    expect(typeof URL_BASE).toBe('string');
  });
});

describe('fetchMultipart', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends FormData with X-Requested-With and credentials', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1 }),
    });

    const formData = new FormData();
    formData.append('file', new File(['x'], 'x.jpg', { type: 'image/jpeg' }));
    await fetchMultipart('/books/1/cover', formData);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/books/1/cover');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(formData);
    expect(options.credentials).toBe('include');
    expect((options.headers as Headers).get('X-Requested-With')).toBe('XMLHttpRequest');
  });

  it('does NOT set Content-Type (browser auto-sets multipart boundary)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const formData = new FormData();
    formData.append('file', new File(['x'], 'x.bin'));
    await fetchMultipart('/upload', formData);

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Headers;
    expect(headers.get('Content-Type')).toBeNull();
  });

  it('merges caller plain-object headers; caller-supplied X-Requested-With overrides default', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const formData = new FormData();
    await fetchMultipart('/upload', formData, {
      headers: { 'X-Requested-With': 'CustomValue', 'X-Custom': 'yes' },
    });

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Headers;
    expect(headers.get('X-Requested-With')).toBe('CustomValue');
    expect(headers.get('X-Custom')).toBe('yes');
  });

  it('merges caller Headers instance; caller-supplied X-Requested-With overrides default', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const formData = new FormData();
    await fetchMultipart('/upload', formData, {
      headers: new Headers({ 'X-Requested-With': 'HeadersOverride', 'X-Custom': 'from-headers' }),
    });

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Headers;
    expect(headers.get('X-Requested-With')).toBe('HeadersOverride');
    expect(headers.get('X-Custom')).toBe('from-headers');
  });

  it('merges caller tuple-array headers; caller-supplied X-Requested-With overrides default', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const formData = new FormData();
    await fetchMultipart('/upload', formData, {
      headers: [['X-Requested-With', 'TupleOverride'], ['X-Custom', 'from-tuple']],
    });

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Headers;
    expect(headers.get('X-Requested-With')).toBe('TupleOverride');
    expect(headers.get('X-Custom')).toBe('from-tuple');
  });

  it('returns parsed JSON body typed as T on 2xx', async () => {
    const payload = { id: 7, coverUrl: '/api/books/7/cover' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    const formData = new FormData();
    const result = await fetchMultipart<{ id: number; coverUrl: string }>('/books/7/cover', formData);
    expect(result).toEqual(payload);
  });

  it('throws ApiError with parsed status and body on 4xx with JSON error body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Bad upload' }),
    });

    const formData = new FormData();
    try {
      await fetchMultipart('/upload', formData);
      throw new Error('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body).toEqual({ error: 'Bad upload' });
    }
  });

  it('falls back to HTTP <status> body and warns when error body is not JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not JSON')),
    });

    const formData = new FormData();
    try {
      await fetchMultipart('/upload', formData);
    } catch (error: unknown) {
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.body).toEqual({ error: 'HTTP 500' });
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('constructs URL via API_BASE so /books/123/cover resolves to /api/books/123/cover', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await fetchMultipart('/books/123/cover', new FormData());

    expect(fetch).toHaveBeenCalledWith('/api/books/123/cover', expect.anything());
  });
});
