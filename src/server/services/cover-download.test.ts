import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { writeFile, rename, readdir, unlink } from 'node:fs/promises';
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
    const writePath = String(vi.mocked(writeFile).mock.calls[0][0]).split('\\').join('/');
    expect(writePath).toContain('/books/test/');
    expect(vi.mocked(writeFile).mock.calls[0][1]).toBeInstanceOf(Buffer);
    // Renamed to final location
    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.jpg');
  });

  it('updates coverUrl to /api/books/{id}/cover in DB after successful download', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        coverUrl: '/api/books/42/cover',
        updatedAt: expect.any(Date),
      }),
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

    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.png');
  });

  it('strips charset suffix from content-type before extension mapping', async () => {
    mockFetch.mockResolvedValue(new Response(Buffer.from('data'), {
      status: 200,
      headers: { 'content-type': 'image/png; charset=utf-8' },
    }));

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover',
      inject<Db>(mockDb), log,
    );

    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.png');
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

    const renameDest = String(vi.mocked(rename).mock.calls[0][1]).split('\\').join('/');
    expect(renameDest).toBe('/books/test/cover.jpg');
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

  describe('URL sanitization in logs', () => {
    it('sanitizes URL with query params in non-OK status warning log', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg?apikey=secret',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('non-OK'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
      expect(warnCall![0].url).not.toContain('secret');
    });

    it('sanitizes URL with query params in non-image content-type warning log', async () => {
      mockFetch.mockResolvedValue(new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg?apikey=secret',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('not an image'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
      expect(warnCall![0].url).not.toContain('secret');
    });

    it('sanitizes URL with query params in exception path warning log', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg?apikey=secret',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Failed to download'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
      expect(warnCall![0].url).not.toContain('secret');
    });

    it('passes through clean URL unchanged in log output', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('non-OK'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
    });

    it('sanitizes URL with userinfo credentials in log output', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }));

      await downloadRemoteCover(
        1, '/books/test', 'https://user:pass@cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('non-OK'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![0].url).not.toContain('user:pass');
      expect(warnCall![0].url).toBe('https://cdn.example.com/cover.jpg');
    });
  });

  describe('timeout constant', () => {
    it('passes HTTP_DOWNLOAD_TIMEOUT_MS to AbortSignal.timeout', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValue(createImageResponse());

      await downloadRemoteCover(
        1, '/books/test', 'https://cdn.example.com/cover.jpg',
        inject<Db>(mockDb), log,
      );

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      timeoutSpy.mockRestore();
    });
  });

  it('returns false and warns on non-OK HTTP status without writing files', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    }));

    const result = await downloadRemoteCover(
      1, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    expect(result).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1, status: 404 }),
      expect.stringContaining('non-OK'),
    );
  });

  it('cleans up stale cover siblings when re-downloading with different extension', async () => {
    mockFetch.mockResolvedValue(createImageResponse('image/jpeg'));
    vi.mocked(readdir).mockResolvedValueOnce(['cover.png', 'cover.jpg', 'audiofile.mp3'] as never);

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    // Should remove stale cover.png (different extension) but not cover.jpg (target) or non-cover files
    const unlinkPath = String(vi.mocked(unlink).mock.calls[0][0]).split('\\').join('/');
    expect(unlinkPath).toBe('/books/test/cover.png');
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('uses unique temp filenames to prevent concurrent download collision', async () => {
    mockFetch.mockResolvedValue(createImageResponse());

    await downloadRemoteCover(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      inject<Db>(mockDb), log,
    );

    const tempPath = vi.mocked(writeFile).mock.calls[0][0] as string;
    // Temp filename should contain a UUID, not just the bookId
    expect(tempPath).toMatch(/\.cover-download-[0-9a-f-]+\.tmp$/);
    expect(tempPath).not.toContain(`-${42}.tmp`);
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
