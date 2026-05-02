import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client.js', () => ({
  URL_BASE: '',
  fetchApi: vi.fn(),
  fetchMultipart: vi.fn(),
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
import { fetchMultipart, ApiError } from './client.js';

describe('booksApi.uploadBookCover', () => {
  beforeEach(() => {
    vi.mocked(fetchMultipart).mockReset();
  });

  it('calls fetchMultipart with the correct path and FormData payload', async () => {
    vi.mocked(fetchMultipart).mockResolvedValue({ id: 1, title: 'Book' });

    const file = new File(['cover-data'], 'cover.jpg', { type: 'image/jpeg' });
    await booksApi.uploadBookCover(42, file);

    expect(fetchMultipart).toHaveBeenCalledOnce();
    const [path, body] = vi.mocked(fetchMultipart).mock.calls[0];
    expect(path).toBe('/books/42/cover');
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBe(file);
  });

  it('surfaces ApiError thrown by fetchMultipart', async () => {
    vi.mocked(fetchMultipart).mockRejectedValue(new ApiError(400, { error: 'bad image' }));

    const file = new File(['data'], 'x.gif', { type: 'image/gif' });
    await expect(booksApi.uploadBookCover(1, file)).rejects.toThrow(ApiError);
  });

  it('returns the parsed body returned by fetchMultipart', async () => {
    const payload = { id: 7, coverUrl: '/api/books/7/cover' };
    vi.mocked(fetchMultipart).mockResolvedValue(payload);

    const file = new File(['data'], 'cover.jpg', { type: 'image/jpeg' });
    const result = await booksApi.uploadBookCover(7, file);
    expect(result).toBe(payload);
  });
});
