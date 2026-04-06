import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { writeFile, rename } from 'node:fs/promises';
import { downloadRemoteCover, isRemoteCoverUrl } from './cover-download.js';

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  });
}

function createMockDb() {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function createImageResponse(contentType = 'image/jpeg', body = Buffer.from('fake-image-data')) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('downloadRemoteCover', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    log = createMockLogger();
  });

  it('downloads image and saves to {bookPath}/cover.{ext} with atomic write', async () => {
    mockFetch.mockResolvedValue(createImageResponse('image/jpeg'));

    const result = await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(true);
    // Temp file written first (atomic write)
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/books/test/'),
      expect.any(Buffer),
    );
    // Renamed to final location
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining('/books/test/'),
      '/books/test/cover.jpg',
    );
  });

  it('updates coverUrl to /api/books/{id}/cover in DB after successful download', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({ coverUrl: '/api/books/42/cover' }),
    );
  });

  it('skips download when coverUrl is null', async () => {
    const result = await downloadRemoteCover(
      1, '/books/test', null as unknown as string,
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips download when coverUrl is empty string', async () => {
    const result = await downloadRemoteCover(
      1, '/books/test', '',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips download when coverUrl is already local (/api/books/:id/cover)', async () => {
    const result = await downloadRemoteCover(
      1, '/books/test', '/api/books/1/cover',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips download when book.path is null', async () => {
    const result = await downloadRemoteCover(
      1, null as unknown as string, 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves external coverUrl when network error occurs', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('preserves external coverUrl when write error occurs', async () => {
    mockFetch.mockResolvedValue(createImageResponse());
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('Disk full'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('logs warning on download failure without throwing', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      expect.stringContaining('cover'),
    );
  });

  it('rejects non-image content-type responses', async () => {
    mockFetch.mockResolvedValue(new Response('<html>Error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('follows redirects (uses native fetch with redirect: follow)', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/cover.jpg',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('infers extension from content-type header', async () => {
    mockFetch.mockResolvedValue(createImageResponse('image/png'));

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.png',
      inject<Db>(mockDb), log,
    );

    expect(rename).toHaveBeenCalledWith(
      expect.any(String),
      '/books/test/cover.png',
    );
  });

  it('defaults to jpg when content-type is a generic image type', async () => {
    mockFetch.mockResolvedValue(new Response(Buffer.from('data'), {
      status: 200,
      headers: { 'content-type': 'image/bmp' },
    }));

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover',
      inject<Db>(mockDb), log,
    );

    expect(rename).toHaveBeenCalledWith(
      expect.any(String),
      '/books/test/cover.jpg',
    );
  });

  it('overwrites existing cover via atomic rename on re-enrichment', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/new-cover.jpg',
      inject<Db>(mockDb), log,
    );

    // rename() overwrites target atomically — no unlink() before rename()
    expect(rename).toHaveBeenCalled();
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
  });

  it('uses AbortSignal.timeout for download timeout', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

describe('isRemoteCoverUrl', () => {
  it('returns true for http:// URLs', () => {
    expect(isRemoteCoverUrl('http://example.com/cover.jpg')).toBe(true);
  });

  it('returns true for https:// URLs', () => {
    expect(isRemoteCoverUrl('https://m.media-amazon.com/images/cover.jpg')).toBe(true);
  });

  it('returns false for local /api/books/:id/cover URLs', () => {
    expect(isRemoteCoverUrl('/api/books/42/cover')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRemoteCoverUrl(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isRemoteCoverUrl('')).toBe(false);
  });
});
