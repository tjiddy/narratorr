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

import { booksApi, RenameConflictError } from './books.js';
import { fetchApi, fetchMultipart, ApiError } from './client.js';

describe('booksApi.uploadBookCover', () => {
  beforeEach(() => {
    vi.mocked(fetchMultipart).mockReset();
  });

  it('calls fetchMultipart with the correct path and FormData payload', async () => {
    vi.mocked(fetchMultipart).mockResolvedValue({ id: 1, title: 'Book' });

    const file = new File(['cover-data'], 'cover.jpg', { type: 'image/jpeg' });
    await booksApi.uploadBookCover(42, file);

    expect(fetchMultipart).toHaveBeenCalledOnce();
    const [path, body] = vi.mocked(fetchMultipart).mock.calls[0]!;
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

describe('booksApi.getBookRenamePreview', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset();
  });

  it('calls GET /books/:id/rename/preview and returns the plan body', async () => {
    const plan = {
      libraryRoot: '/library',
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
      folderMove: { from: 'a', to: 'b' },
      fileRenames: [{ from: 'x.m4b', to: 'y.m4b' }],
    };
    vi.mocked(fetchApi).mockResolvedValue(plan);

    const result = await booksApi.getBookRenamePreview(42);

    expect(fetchApi).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchApi).mock.calls[0]![0]).toBe('/books/42/rename/preview');
    expect(result).toEqual(plan);
  });

  it('throws RenameConflictError when 409 has code: CONFLICT and conflictingBook', async () => {
    vi.mocked(fetchApi).mockRejectedValue(
      new ApiError(409, {
        error: 'Target path already belongs to "Other" (book #2)',
        code: 'CONFLICT',
        conflictingBook: { id: 2, title: 'Other' },
      }),
    );

    await expect(booksApi.getBookRenamePreview(1)).rejects.toBeInstanceOf(RenameConflictError);
    await expect(booksApi.getBookRenamePreview(1)).rejects.toMatchObject({
      conflictingBook: { id: 2, title: 'Other' },
    });
  });

  it('propagates non-conflict ApiErrors (e.g. 404) without wrapping', async () => {
    vi.mocked(fetchApi).mockRejectedValue(new ApiError(404, { error: 'Book not found' }));

    const err = await booksApi.getBookRenamePreview(999).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(RenameConflictError);
  });

  it('propagates 409 without a CONFLICT body as a plain ApiError', async () => {
    // Not the structured shape — should not be converted to RenameConflictError
    vi.mocked(fetchApi).mockRejectedValue(new ApiError(409, { error: 'random conflict' }));

    const err = await booksApi.getBookRenamePreview(1).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(RenameConflictError);
  });
});
