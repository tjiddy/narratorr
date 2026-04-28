import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client.js', () => ({
  URL_BASE: '',
  fetchApi: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super((body as { error?: string })?.error || `HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  },
}));

import { booksApi } from './books.js';

describe('booksApi.uploadBookCover', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('sends FormData with credentials and X-Requested-With CSRF header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, title: 'Book' }),
    });

    const file = new File(['cover-data'], 'cover.jpg', { type: 'image/jpeg' });
    await booksApi.uploadBookCover(42, file);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/books/42/cover');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'X-Requested-With': 'XMLHttpRequest' });
  });
});
