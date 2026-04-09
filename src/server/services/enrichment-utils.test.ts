import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
}));

import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { writeFile, readdir } from 'node:fs/promises';
import { enrichBookFromAudio } from './enrichment-utils.js';

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

describe('enrichBookFromAudio', () => {
  let mockDb: { update: ReturnType<typeof vi.fn> };
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    log = createMockLogger();
  });

  it('writes technical metadata when scan succeeds', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'MPEG',
      fileCount: 10,
      totalSize: 500_000_000,
      totalDuration: 36000,
      hasCoverArt: false,
    });
    vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3', 'cover.jpg'] as never);

    const result = await enrichBookFromAudio(
      1,
      '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(result.enriched).toBe(true);
    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        audioCodec: 'mp3',
        audioBitrate: 128000,
        audioSampleRate: 44100,
        audioChannels: 2,
        topLevelAudioFileCount: 2,
        enrichmentStatus: 'file-enriched',
        duration: 600, // 36000 / 60
      }),
    );
  });

  it('returns not enriched when scan returns null', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(null);

    const result = await enrichBookFromAudio(
      1,
      '/books/empty',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(result.enriched).toBe(false);
    expect(result.error).toBeUndefined();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('fills narrator from tags when book has no narrator via bookService.update', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'MPEG',
      fileCount: 1,
      totalSize: 1000,
      totalDuration: 100,
      tagNarrator: 'Tim Gerard Reynolds',
      hasCoverArt: false,
    });

    const mockBookService = inject<BookService>({ update: vi.fn().mockResolvedValue(null) });

    await enrichBookFromAudio(
      1,
      '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
      mockBookService,
    );

    expect(mockBookService.update).toHaveBeenCalledWith(1, { narrators: ['Tim Gerard Reynolds'] });
    // narrator NOT in db.update (goes through junction table instead)
    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(expect.not.objectContaining({ narrator: expect.anything() }));
  });

  it('does not overwrite existing narrator', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'MPEG',
      fileCount: 1,
      totalSize: 1000,
      totalDuration: 100,
      tagNarrator: 'Wrong Narrator',
      hasCoverArt: false,
    });

    const mockBookService = inject<BookService>({ update: vi.fn().mockResolvedValue(null) });

    await enrichBookFromAudio(
      1,
      '/books/test',
      { narrators: [{ name: 'Correct Narrator' }], duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
      mockBookService,
    );

    expect(mockBookService.update).not.toHaveBeenCalled();
  });

  it('saves cover art when book has no coverUrl', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'MPEG',
      fileCount: 1,
      totalSize: 1000,
      totalDuration: 100,
      coverImage: Buffer.from('fake-image'),
      coverMimeType: 'image/jpeg',
      hasCoverArt: true,
    });

    await enrichBookFromAudio(
      42,
      '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('cover.jpg'), expect.any(Buffer));
    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({ coverUrl: '/api/books/42/cover' }),
    );
  });

  it('skips cover art when book already has coverUrl', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'MPEG',
      fileCount: 1,
      totalSize: 1000,
      totalDuration: 100,
      coverImage: Buffer.from('fake-image'),
      hasCoverArt: true,
    });

    await enrichBookFromAudio(
      1,
      '/books/test',
      { narrators: null, duration: null, coverUrl: '/api/books/1/cover' },
      inject<Db>(mockDb),
      log,
    );

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('forwards ffprobePath and log to scanAudioDirectory when provided', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100, hasCoverArt: false,
    });

    await enrichBookFromAudio(
      1, '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb), log, undefined, '/usr/bin/ffprobe',
    );

    expect(scanAudioDirectory).toHaveBeenCalledWith('/books/test', { ffprobePath: '/usr/bin/ffprobe', log });
  });

  it('passes ffprobePath as undefined to scanAudioDirectory when not provided', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100, hasCoverArt: false,
    });

    await enrichBookFromAudio(
      1, '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb), log,
    );

    expect(scanAudioDirectory).toHaveBeenCalledWith('/books/test', { ffprobePath: undefined, log });
  });

  it('returns error info when scan throws', async () => {
    vi.mocked(scanAudioDirectory).mockRejectedValue(new Error('Permission denied'));

    const result = await enrichBookFromAudio(
      1,
      '/books/locked',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(result.enriched).toBe(false);
    expect(result.error).toBe('Permission denied');
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('maps png mime type to .png extension', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3',
      bitrate: 128000,
      sampleRate: 44100,
      channels: 2,
      bitrateMode: 'cbr' as const,
      fileFormat: 'MPEG',
      fileCount: 1,
      totalSize: 1000,
      totalDuration: 100,
      coverImage: Buffer.from('fake-image'),
      coverMimeType: 'image/png',
      hasCoverArt: true,
    });

    await enrichBookFromAudio(
      1,
      '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('cover.png'), expect.any(Buffer));
  });
});

describe('enrichment-utils — narrator junction writes (#71)', () => {
  let mockDb: { update: ReturnType<typeof vi.fn> };
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    log = inject<FastifyBaseLogger>({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info',
    });
  });

  it('updates a book with no prior narrators → calls bookService.update with narrator array', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100,
      tagNarrator: 'Kate Reading',
      hasCoverArt: false,
    });

    const mockBookService = inject<BookService>({ update: vi.fn().mockResolvedValue(null) });

    await enrichBookFromAudio(
      5,
      '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
      mockBookService,
    );

    expect(mockBookService.update).toHaveBeenCalledWith(5, { narrators: ['Kate Reading'] });
  });

  it('skips bookService.update when no tagNarrator in scan result', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100,
      hasCoverArt: false,
      // no tagNarrator
    });

    const mockBookService = inject<BookService>({ update: vi.fn().mockResolvedValue(null) });

    await enrichBookFromAudio(
      5,
      '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
      mockBookService,
    );

    expect(mockBookService.update).not.toHaveBeenCalled();
  });

  it('skips bookService.update when bookService not provided', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100,
      tagNarrator: 'Kate Reading',
      hasCoverArt: false,
    });

    // No bookService — should not throw
    await expect(
      enrichBookFromAudio(5, '/books/test', { narrators: null, duration: null, coverUrl: null }, inject<Db>(mockDb), log),
    ).resolves.toEqual({ enriched: true });
  });
});

describe('enrichBookFromAudio narrator splitting (issue #79)', () => {
  let mockDb: { update: ReturnType<typeof vi.fn> };
  let log: FastifyBaseLogger;
  let mockBookService: { update: ReturnType<typeof vi.fn> };

  function scanWithNarrator(tagNarrator: string | undefined) {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100, hasCoverArt: false,
      tagNarrator,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    };
    log = inject<FastifyBaseLogger>({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info',
    });
    mockBookService = { update: vi.fn().mockResolvedValue(null) };
  });

  async function callEnrich(tagNarrator: string | undefined) {
    scanWithNarrator(tagNarrator);
    return enrichBookFromAudio(
      5, '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
      inject<BookService>(mockBookService),
    );
  }

  it('single narrator string → one narrator entity created', async () => {
    await callEnrich('Michael Kramer');
    expect(mockBookService.update).toHaveBeenCalledWith(5, { narrators: ['Michael Kramer'] });
  });

  it('"Alice, Bob" → two narrator entities (comma split)', async () => {
    await callEnrich('Alice, Bob');
    expect(mockBookService.update).toHaveBeenCalledWith(5, { narrators: ['Alice', 'Bob'] });
  });

  it('"Alice; Bob" → two narrator entities (semicolon split)', async () => {
    await callEnrich('Alice; Bob');
    expect(mockBookService.update).toHaveBeenCalledWith(5, { narrators: ['Alice', 'Bob'] });
  });

  it('"Alice & Bob" → two narrator entities (ampersand split)', async () => {
    await callEnrich('Alice & Bob');
    expect(mockBookService.update).toHaveBeenCalledWith(5, { narrators: ['Alice', 'Bob'] });
  });

  it('"  Alice  ,  Bob  " → names trimmed before junction write', async () => {
    await callEnrich('  Alice  ,  Bob  ');
    expect(mockBookService.update).toHaveBeenCalledWith(5, { narrators: ['Alice', 'Bob'] });
  });

  it('empty string "" → no narrator entities created', async () => {
    await callEnrich('');
    expect(mockBookService.update).not.toHaveBeenCalled();
  });

  it('null/missing narrator tag → no narrator entities created; existing junctions unchanged', async () => {
    await callEnrich(undefined);
    expect(mockBookService.update).not.toHaveBeenCalled();
  });
});

vi.mock('./cover-download.js', () => ({
  downloadRemoteCover: vi.fn().mockResolvedValue(true),
  isRemoteCoverUrl: vi.fn((url: string | null | undefined) => {
    if (!url) return false;
    return url.startsWith('http://') || url.startsWith('https://');
  }),
}));

import { downloadRemoteCover } from './cover-download.js';

describe('enrichBookFromAudio — remote cover download integration (#369)', () => {
  let mockDb: { update: ReturnType<typeof vi.fn> };
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    log = inject<FastifyBaseLogger>({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info',
    });
  });

  function scanWithNoEmbeddedCover() {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100, hasCoverArt: false,
    });
  }

  function scanWithEmbeddedCover() {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'mp3', bitrate: 128000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'MPEG', fileCount: 1,
      totalSize: 1000, totalDuration: 100, hasCoverArt: true,
      coverImage: Buffer.from('fake-image'), coverMimeType: 'image/jpeg',
    });
  }

  it('fires downloadRemoteCover when book has remote coverUrl and no embedded cover', async () => {
    scanWithNoEmbeddedCover();

    await enrichBookFromAudio(
      42, '/books/test',
      { narrators: null, duration: null, coverUrl: 'https://cdn.example.com/cover.jpg' },
      inject<Db>(mockDb), log,
    );

    expect(downloadRemoteCover).toHaveBeenCalledWith(
      42, '/books/test', 'https://cdn.example.com/cover.jpg',
      expect.anything(), log,
    );
  });

  it('does not fire downloadRemoteCover when coverUrl is already local', async () => {
    scanWithNoEmbeddedCover();

    await enrichBookFromAudio(
      42, '/books/test',
      { narrators: null, duration: null, coverUrl: '/api/books/42/cover' },
      inject<Db>(mockDb), log,
    );

    expect(downloadRemoteCover).not.toHaveBeenCalled();
  });

  it('does not fire downloadRemoteCover when embedded cover was saved', async () => {
    scanWithEmbeddedCover();

    await enrichBookFromAudio(
      42, '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb), log,
    );

    // Embedded cover was saved, update.coverUrl was set → no remote download
    expect(downloadRemoteCover).not.toHaveBeenCalled();
  });

  it('does not fire downloadRemoteCover when coverUrl is null', async () => {
    scanWithNoEmbeddedCover();

    await enrichBookFromAudio(
      42, '/books/test',
      { narrators: null, duration: null, coverUrl: null },
      inject<Db>(mockDb), log,
    );

    expect(downloadRemoteCover).not.toHaveBeenCalled();
  });

  it('download failure does not affect enrichment result (fire-and-forget)', async () => {
    scanWithNoEmbeddedCover();
    vi.mocked(downloadRemoteCover).mockRejectedValueOnce(new Error('Network failure'));

    const result = await enrichBookFromAudio(
      42, '/books/test',
      { narrators: null, duration: null, coverUrl: 'https://cdn.example.com/cover.jpg' },
      inject<Db>(mockDb), log,
    );

    expect(result.enriched).toBe(true);

    // Wait for fire-and-forget .catch() to execute
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 42 }),
      expect.stringContaining('cover'),
    );
  });
});
