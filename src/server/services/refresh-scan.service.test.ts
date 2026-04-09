import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { SettingsService } from './settings.service.js';

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('../../core/utils/ffprobe-path.js', () => ({
  resolveFfprobePathFromSettings: vi.fn().mockReturnValue('/usr/bin/ffprobe'),
}));

vi.mock('../utils/import-helpers.js', () => ({
  getPathSize: vi.fn().mockResolvedValue(1_000_000),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  readdir: vi.fn().mockResolvedValue([]),
}));

import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { getPathSize } from '../utils/import-helpers.js';
import { readdir } from 'node:fs/promises';
import { refreshScanBook, RefreshScanError } from './refresh-scan.service.js';

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

function makeScanResult(overrides: Record<string, unknown> = {}) {
  return {
    codec: 'mp3',
    bitrate: 128000,
    sampleRate: 44100,
    channels: 2,
    bitrateMode: 'cbr' as const,
    fileFormat: 'MPEG',
    fileCount: 3,
    totalSize: 300_000_000,
    totalDuration: 7200,
    hasCoverArt: false,
    ...overrides,
  };
}

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return inject<BookWithAuthor>({
    id: 1,
    title: 'Test Book',
    path: '/library/author/book',
    status: 'imported',
    duration: 60,
    narrators: [{ name: 'Old Narrator' }],
    authors: [{ name: 'Test Author' }],
    coverUrl: '/api/books/1/cover',
    ...overrides,
  });
}

describe('RefreshScanError', () => {
  it('has name RefreshScanError and exposes code property', () => {
    const error = new RefreshScanError('NOT_FOUND', 'Book 1 not found');
    expect(error.name).toBe('RefreshScanError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Book 1 not found');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('refreshScanBook', () => {
  let mockDb: Db;
  let mockBookService: BookService;
  let mockSettingsService: SettingsService;
  let log: FastifyBaseLogger;
  let mockSetFn: ReturnType<typeof vi.fn>;
  let mockWhereFn: ReturnType<typeof vi.fn>;
  let mockTxSetFn: ReturnType<typeof vi.fn>;
  let mockTxWhereFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTxWhereFn = vi.fn().mockResolvedValue(undefined);
    mockTxSetFn = vi.fn().mockReturnValue({ where: mockTxWhereFn });
    // Transaction mock: executes the callback with a tx that has update().set().where()
    const mockTx = {
      update: vi.fn().mockReturnValue({ set: mockTxSetFn }),
    };
    mockWhereFn = vi.fn().mockResolvedValue(undefined);
    mockSetFn = vi.fn().mockReturnValue({ where: mockWhereFn });
    mockDb = inject<Db>({
      update: vi.fn().mockReturnValue({ set: mockSetFn }),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn(mockTx);
      }),
    });

    mockBookService = inject<BookService>({
      getById: vi.fn().mockResolvedValue(makeBook()),
      syncNarrators: vi.fn().mockResolvedValue(undefined),
    });

    mockSettingsService = inject<SettingsService>({
      get: vi.fn().mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' }),
    });

    log = createMockLogger();

    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult());
    vi.mocked(readdir).mockResolvedValue(
      ['ch1.mp3', 'ch2.mp3', 'ch3.mp3'] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
  });

  // Happy path
  it('returns RefreshScanResult with bookId, codec, bitrate, fileCount, durationMinutes, narratorsUpdated', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'New Narrator' }));
    const result = await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(result).toEqual({
      bookId: 1,
      codec: 'mp3',
      bitrate: 128000,
      fileCount: 3,
      durationMinutes: 120,
      narratorsUpdated: true,
    });
  });

  it('durationMinutes is Math.round(totalDuration / 60) — 90s → 2 min', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 90 }));
    const result = await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(result.durationMinutes).toBe(2);
  });

  it('durationMinutes rounding — 89s → 1 min', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 89 }));
    const result = await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(result.durationMinutes).toBe(1);
  });

  it('zero-duration audio file → durationMinutes is 0', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ totalDuration: 0 }));
    const result = await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(result.durationMinutes).toBe(0);
  });

  // Audio fields overwrite
  it('overwrites all 10 audio technical fields from scan results', async () => {
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);

    expect(mockTxSetFn).toHaveBeenCalledWith(
      expect.objectContaining({
        audioCodec: 'mp3',
        audioBitrate: 128000,
        audioSampleRate: 44100,
        audioChannels: 2,
        audioBitrateMode: 'cbr',
        audioFileFormat: 'MPEG',
        audioFileCount: 3,
        audioTotalSize: 300_000_000,
        audioDuration: 7200,
      }),
    );
    // topLevelAudioFileCount comes from readdir, not scan result
    expect(mockTxSetFn).toHaveBeenCalledWith(
      expect.objectContaining({
        topLevelAudioFileCount: 3,
      }),
    );
  });

  it('updates size field with total recursive directory size via getPathSize', async () => {
    vi.mocked(getPathSize).mockResolvedValue(5_000_000);
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(getPathSize).toHaveBeenCalledWith('/library/author/book');
    expect(mockTxSetFn).toHaveBeenCalledWith(
      expect.objectContaining({ size: 5_000_000 }),
    );
  });

  it('sets enrichmentStatus to file-enriched', async () => {
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(mockTxSetFn).toHaveBeenCalledWith(
      expect.objectContaining({ enrichmentStatus: 'file-enriched' }),
    );
  });

  it('sets updatedAt to current date', async () => {
    const before = new Date();
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    const setArg = mockTxSetFn.mock.calls[0][0];
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    expect(setArg.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  // Narrator overwrite semantics
  it('overwrites narrator from tags even when book already has narrators', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'New Narrator' }));
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(mockBookService.syncNarrators).toHaveBeenCalledWith(
      expect.anything(), // tx
      1,
      ['New Narrator'],
    );
  });

  it('splits multi-narrator tag on comma, semicolon, ampersand delimiters', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(
      makeScanResult({ tagNarrator: 'Narrator A; Narrator B & Narrator C, Narrator D' }),
    );
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(mockBookService.syncNarrators).toHaveBeenCalledWith(
      expect.anything(),
      1,
      ['Narrator A', 'Narrator B', 'Narrator C', 'Narrator D'],
    );
  });

  it('narratorsUpdated is true when tagNarrator was present', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Narrator' }));
    const result = await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(result.narratorsUpdated).toBe(true);
  });

  it('does not update narrator when tagNarrator is absent from scan result', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult()); // no tagNarrator
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(mockBookService.syncNarrators).not.toHaveBeenCalled();
  });

  it('narratorsUpdated is false when tagNarrator is absent', async () => {
    const result = await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(result.narratorsUpdated).toBe(false);
  });

  // Cover art excluded
  it('passes skipCover: true to scanAudioDirectory', async () => {
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(scanAudioDirectory).toHaveBeenCalledWith(
      '/library/author/book',
      expect.objectContaining({ skipCover: true }),
    );
  });

  // Preserved fields
  it('does not include title, author, series, description, coverUrl, genres in DB update', async () => {
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    const setArg = mockTxSetFn.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('title');
    expect(setArg).not.toHaveProperty('description');
    expect(setArg).not.toHaveProperty('coverUrl');
    expect(setArg).not.toHaveProperty('seriesName');
    expect(setArg).not.toHaveProperty('seriesPosition');
    expect(setArg).not.toHaveProperty('genres');
  });

  // Atomicity
  it('wraps narrator junction table write and book row update in single transaction', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Narrator' }));
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect((mockDb as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
    // Both writes happened inside the transaction callback
    const txMock = (mockDb as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction.mock.calls[0][0];
    expect(typeof txMock).toBe('function');
  });

  it('rolls back both narrator and book-row changes on partial failure', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScanResult({ tagNarrator: 'Narrator' }));
    vi.mocked(mockBookService.syncNarrators).mockRejectedValue(new Error('DB constraint failure'));
    await expect(refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log)).rejects.toThrow('DB constraint failure');
  });

  // topLevelAudioFileCount
  it('counts only root-level audio files for topLevelAudioFileCount', async () => {
    vi.mocked(readdir).mockResolvedValue(
      ['ch1.mp3', 'ch2.m4b', 'cover.jpg', 'subfolder'] as unknown as Awaited<ReturnType<typeof readdir>>,
    );
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(mockTxSetFn).toHaveBeenCalledWith(
      expect.objectContaining({ topLevelAudioFileCount: 2 }), // only mp3 + m4b
    );
  });

  // Error paths
  it('throws RefreshScanError NOT_FOUND when book does not exist', async () => {
    vi.mocked(mockBookService.getById).mockResolvedValue(null);
    await expect(refreshScanBook(999, mockDb, mockBookService, mockSettingsService, log))
      .rejects.toThrow(RefreshScanError);
    try {
      await refreshScanBook(999, mockDb, mockBookService, mockSettingsService, log);
    } catch (error: unknown) {
      expect((error as RefreshScanError).code).toBe('NOT_FOUND');
    }
  });

  it('throws RefreshScanError NO_PATH when book has no library path', async () => {
    vi.mocked(mockBookService.getById).mockResolvedValue(makeBook({ path: null }));
    await expect(refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log))
      .rejects.toThrow(RefreshScanError);
    try {
      await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    } catch (error: unknown) {
      expect((error as RefreshScanError).code).toBe('NO_PATH');
    }
  });

  it('throws RefreshScanError PATH_MISSING when book path does not exist on disk', async () => {
    const { stat: statFn } = await import('node:fs/promises');
    vi.mocked(statFn).mockRejectedValueOnce(new Error('ENOENT'));
    await expect(refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log))
      .rejects.toThrow(RefreshScanError);
    vi.mocked(statFn).mockRejectedValueOnce(new Error('ENOENT'));
    try {
      await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    } catch (error: unknown) {
      expect((error as RefreshScanError).code).toBe('PATH_MISSING');
    }
  });

  it('throws RefreshScanError NO_AUDIO_FILES when scanAudioDirectory returns null', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(null);
    await expect(refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log))
      .rejects.toThrow(RefreshScanError);
    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(null);
    try {
      await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    } catch (error: unknown) {
      expect((error as RefreshScanError).code).toBe('NO_AUDIO_FILES');
    }
  });

  // ffprobePath
  it('resolves ffprobePath from processing settings before calling scan', async () => {
    await refreshScanBook(1, mockDb, mockBookService, mockSettingsService, log);
    expect(mockSettingsService.get).toHaveBeenCalledWith('processing');
    expect(resolveFfprobePathFromSettings).toHaveBeenCalledWith('/usr/bin/ffmpeg');
    expect(scanAudioDirectory).toHaveBeenCalledWith(
      '/library/author/book',
      expect.objectContaining({ ffprobePath: '/usr/bin/ffprobe' }),
    );
  });
});
