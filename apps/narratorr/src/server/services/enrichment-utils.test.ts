import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';

vi.mock('@narratorr/core/utils/audio-scanner', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { scanAudioDirectory } from '@narratorr/core/utils/audio-scanner';
import { writeFile } from 'node:fs/promises';
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

    const result = await enrichBookFromAudio(
      1,
      '/books/test',
      { narrator: null, duration: null, coverUrl: null },
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
      { narrator: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(result.enriched).toBe(false);
    expect(result.error).toBeUndefined();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('fills narrator from tags when book has no narrator', async () => {
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

    await enrichBookFromAudio(
      1,
      '/books/test',
      { narrator: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({ narrator: 'Tim Gerard Reynolds' }),
    );
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

    await enrichBookFromAudio(
      1,
      '/books/test',
      { narrator: 'Correct Narrator', duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    const setCall = mockDb.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.not.objectContaining({ narrator: expect.anything() }),
    );
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
      { narrator: null, duration: null, coverUrl: null },
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
      { narrator: null, duration: null, coverUrl: '/api/books/1/cover' },
      inject<Db>(mockDb),
      log,
    );

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns error info when scan throws', async () => {
    vi.mocked(scanAudioDirectory).mockRejectedValue(new Error('Permission denied'));

    const result = await enrichBookFromAudio(
      1,
      '/books/locked',
      { narrator: null, duration: null, coverUrl: null },
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
      { narrator: null, duration: null, coverUrl: null },
      inject<Db>(mockDb),
      log,
    );

    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('cover.png'), expect.any(Buffer));
  });
});
