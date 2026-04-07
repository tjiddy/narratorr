import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import { readdir, copyFile, mkdir, rm, readFile, unlink } from 'node:fs/promises';
import { preserveBookCover, cleanCoverCache, serveCoverFromCache, COVER_FILE_REGEX } from './cover-cache.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    copyFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
  };
});

describe('COVER_FILE_REGEX', () => {
  it('matches cover.jpg, cover.jpeg, cover.png, cover.webp (case-insensitive)', () => {
    expect(COVER_FILE_REGEX.test('cover.jpg')).toBe(true);
    expect(COVER_FILE_REGEX.test('cover.jpeg')).toBe(true);
    expect(COVER_FILE_REGEX.test('cover.png')).toBe(true);
    expect(COVER_FILE_REGEX.test('cover.webp')).toBe(true);
    expect(COVER_FILE_REGEX.test('cover.JPG')).toBe(true);
    expect(COVER_FILE_REGEX.test('cover.Png')).toBe(true);
  });

  it('does not match non-cover files', () => {
    expect(COVER_FILE_REGEX.test('chapter01.mp3')).toBe(false);
    expect(COVER_FILE_REGEX.test('metadata.nfo')).toBe(false);
    expect(COVER_FILE_REGEX.test('cover.gif')).toBe(false);
  });
});

describe('preserveBookCover', () => {
  const log = inject<FastifyBaseLogger>(createMockLogger());

  beforeEach(() => vi.clearAllMocks());

  it('copies cover.jpg from book directory to cache at {configPath}/covers/{bookId}/cover.jpg', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['chapter01.m4b', 'cover.jpg']);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    const mkdirPath = String(vi.mocked(mkdir).mock.calls[0][0]).split('\\').join('/');
    expect(mkdirPath).toBe('/config/covers/42');
    expect(vi.mocked(mkdir).mock.calls[0][1]).toEqual({ recursive: true });
    const copySrc = String(vi.mocked(copyFile).mock.calls[0][0]).split('\\').join('/');
    const copyDst = String(vi.mocked(copyFile).mock.calls[0][1]).split('\\').join('/');
    expect(copySrc).toBe('/library/Author/Book/cover.jpg');
    expect(copyDst).toBe('/config/covers/42/cover.jpg');
  });

  it('copies cover.png to cache (verifies multiple extensions work)', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.png']);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    const copySrc = String(vi.mocked(copyFile).mock.calls[0][0]).split('\\').join('/');
    const copyDst = String(vi.mocked(copyFile).mock.calls[0][1]).split('\\').join('/');
    expect(copySrc).toBe('/library/Author/Book/cover.png');
    expect(copyDst).toBe('/config/covers/42/cover.png');
  });

  it('does nothing when no cover file exists in book directory', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['chapter01.m4b', 'metadata.nfo']);

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    expect(mkdir).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('creates cache directory on demand (mkdir recursive) if it does not exist', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.webp']);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    const mkdirPath = String(vi.mocked(mkdir).mock.calls[0][0]).split('\\').join('/');
    expect(mkdirPath).toBe('/config/covers/42');
  });

  it('overwrites existing cache entry if one already exists (idempotent)', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.jpg']);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Call twice — both should succeed without error
    await preserveBookCover('/library/Author/Book', 42, '/config', log);
    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    expect(copyFile).toHaveBeenCalledTimes(2);
  });

  it('removes stale cover siblings when extension changes (jpg → png)', async () => {
    // Book directory has cover.png
    (readdir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(['cover.png'])        // readdir(bookPath) — find new cover
      .mockResolvedValueOnce(['cover.jpg']);         // readdir(cacheDir) — stale sibling
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    // Should remove the stale cover.jpg before copying cover.png
    const unlinkPath = String(vi.mocked(unlink).mock.calls[0][0]).split('\\').join('/');
    expect(unlinkPath).toBe('/config/covers/42/cover.jpg');
    const copySrc = String(vi.mocked(copyFile).mock.calls[0][0]).split('\\').join('/');
    const copyDst = String(vi.mocked(copyFile).mock.calls[0][1]).split('\\').join('/');
    expect(copySrc).toBe('/library/Author/Book/cover.png');
    expect(copyDst).toBe('/config/covers/42/cover.png');
  });

  it('does not remove same-extension file when overwriting', async () => {
    (readdir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(['cover.jpg'])        // readdir(bookPath)
      .mockResolvedValueOnce(['cover.jpg']);         // readdir(cacheDir) — same extension
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    expect(unlink).not.toHaveBeenCalled();
  });

  it('returns without error when readdir fails (best-effort, logs warn)', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42 }),
      expect.stringContaining('cover'),
    );
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('returns without error when copyFile fails (best-effort, logs warn)', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.jpg']);
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (copyFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'));

    await preserveBookCover('/library/Author/Book', 42, '/config', log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42 }),
      expect.stringContaining('cover'),
    );
  });
});

describe('cleanCoverCache', () => {
  const log = inject<FastifyBaseLogger>(createMockLogger());

  beforeEach(() => vi.clearAllMocks());

  it('removes cover cache directory for the given bookId', async () => {
    (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await cleanCoverCache(42, '/config', log);

    const rmPath = String(vi.mocked(rm).mock.calls[0][0]).split('\\').join('/');
    expect(rmPath).toBe('/config/covers/42');
    expect(vi.mocked(rm).mock.calls[0][1]).toEqual({ recursive: true, force: true });
  });

  it('does nothing when no cache entry exists (idempotent, no error)', async () => {
    (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // force: true means rm won't throw for missing dirs
    await cleanCoverCache(999, '/config', log);

    const rmPath = String(vi.mocked(rm).mock.calls[0][0]).split('\\').join('/');
    expect(rmPath).toBe('/config/covers/999');
    expect(vi.mocked(rm).mock.calls[0][1]).toEqual({ recursive: true, force: true });
  });

  it('returns without error when rm fails (best-effort, logs warn)', async () => {
    (rm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'));

    await cleanCoverCache(42, '/config', log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42 }),
      expect.stringContaining('cover cache'),
    );
  });
});

describe('serveCoverFromCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cover file data and MIME type when cached cover exists', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.jpg']);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('fake-jpg'));

    const result = await serveCoverFromCache(42, '/config');

    expect(result).toEqual({
      data: Buffer.from('fake-jpg'),
      mime: 'image/jpeg',
    });
  });

  it('returns null when no cached cover exists', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const result = await serveCoverFromCache(42, '/config');

    expect(result).toBeNull();
  });

  it('returns correct MIME for jpg', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.jpg']);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('data'));

    const result = await serveCoverFromCache(42, '/config');

    expect(result?.mime).toBe('image/jpeg');
  });

  it('returns correct MIME for png', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.png']);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('data'));

    const result = await serveCoverFromCache(42, '/config');

    expect(result?.mime).toBe('image/png');
  });

  it('returns correct MIME for webp', async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(['cover.webp']);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('data'));

    const result = await serveCoverFromCache(42, '/config');

    expect(result?.mime).toBe('image/webp');
  });
});
