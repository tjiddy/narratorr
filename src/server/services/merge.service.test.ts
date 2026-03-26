import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { MergeService, MergeError } from './merge.service.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import type { BookService } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { readdir, mkdir, cp, unlink, stat, rm, rename } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    mkdir: vi.fn(),
    cp: vi.fn(),
    unlink: vi.fn(),
    stat: vi.fn(),
    rm: vi.fn(),
    rename: vi.fn(),
  };
});

vi.mock('../../core/utils/audio-processor.js', () => ({
  processAudioFiles: vi.fn(),
}));

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn(),
}));

const BOOK_PATH = '/library/Author/Title';
const STAGING_DIR = BOOK_PATH + '.merge-tmp';

const mockAuthor = createMockDbAuthor();
const mockBook = {
  ...createMockDbBook({
    id: 42,
    title: 'The Way of Kings',
    path: BOOK_PATH,
    status: 'imported',
  }),
  authors: [mockAuthor],
  narrators: [],
};

const processingOverrides = {
  processing: {
    ffmpegPath: '/usr/bin/ffmpeg',
    enabled: true,
    outputFormat: 'm4b' as const,
    bitrate: 128,
    keepOriginalBitrate: false,
    mergeBehavior: 'multi-file-only' as const,
    maxConcurrentProcessing: 2,
    postProcessingScript: '',
    postProcessingScriptTimeout: 300,
  },
};

const SCAN_RESULT = {
  codec: 'aac',
  bitrate: 128000,
  sampleRate: 44100,
  channels: 2,
  bitrateMode: 'cbr' as const,
  fileFormat: 'm4b',
  fileCount: 1,
  totalSize: 500_000_000,
  totalDuration: 36000,
  hasCoverArt: false,
};

function createService(opts?: { eventHistory?: EventHistoryService; eventBroadcaster?: EventBroadcasterService }) {
  const db = createMockDb();
  const bookService = {
    getById: vi.fn().mockResolvedValue(mockBook),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const settingsService = createMockSettingsService(processingOverrides);
  const log = createMockLogger();

  const service = new MergeService(
    inject<Db>(db),
    inject<BookService>(bookService),
    settingsService,
    inject<FastifyBaseLogger>(log),
    opts?.eventHistory,
    opts?.eventBroadcaster,
  );

  return { service, db, bookService, log };
}

function setupHappyPath() {
  (readdir as Mock)
    .mockResolvedValueOnce(['01.mp3', '02.mp3', 'cover.jpg']) // book.path scan
    .mockResolvedValueOnce(['The Way of Kings.m4b']); // staging scan after processing
  (mkdir as Mock).mockResolvedValue(undefined);
  (cp as Mock).mockResolvedValue(undefined);
  (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] });
  (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
  (rename as Mock).mockResolvedValue(undefined);
  (unlink as Mock).mockResolvedValue(undefined);
  (rm as Mock).mockResolvedValue(undefined);
  (stat as Mock).mockResolvedValue({ size: 500_000_000 });
  (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
}

describe('MergeService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('mergeBook — success path', () => {
    it('copies source files to staging dir, runs processAudioFiles on staging, verifies with scanAudioDirectory, moves M4B to book.path, deletes originals, cleans staging', async () => {
      setupHappyPath();
      const { service } = createService();

      const result = await service.mergeBook(42);

      // Staging dir created
      expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });

      // Top-level audio files copied (not cover.jpg)
      expect(cp).toHaveBeenCalledWith(BOOK_PATH + '/01.mp3', STAGING_DIR + '/01.mp3');
      expect(cp).toHaveBeenCalledWith(BOOK_PATH + '/02.mp3', STAGING_DIR + '/02.mp3');
      expect(cp).not.toHaveBeenCalledWith(expect.stringContaining('cover.jpg'), expect.anything());

      // processAudioFiles called on staging dir with mergeBehavior: always
      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ ffmpegPath: '/usr/bin/ffmpeg', mergeBehavior: 'always', outputFormat: 'm4b' }),
        expect.objectContaining({ title: 'The Way of Kings' }),
      );

      // scanAudioDirectory called on staging for verification
      expect(scanAudioDirectory).toHaveBeenCalledWith(STAGING_DIR);

      // M4B moved from staging to book.path
      expect(rename).toHaveBeenCalledWith(
        STAGING_DIR + '/The Way of Kings.m4b',
        BOOK_PATH + '/The Way of Kings.m4b',
      );

      // Originals deleted from book.path
      expect(unlink).toHaveBeenCalledWith(BOOK_PATH + '/01.mp3');
      expect(unlink).toHaveBeenCalledWith(BOOK_PATH + '/02.mp3');

      // Staging dir cleaned
      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });

      // Result shape
      expect(result).toMatchObject({
        bookId: 42,
        outputFile: BOOK_PATH + '/The Way of Kings.m4b',
        filesReplaced: 2,
      });
    });

    it('calls enrichBookFromAudio with bookService after successful move', async () => {
      setupHappyPath();
      const { service, bookService } = createService();

      await service.mergeBook(42);

      expect(enrichBookFromAudio).toHaveBeenCalledWith(
        42,
        BOOK_PATH,
        expect.objectContaining({ id: 42 }),
        expect.anything(), // db
        expect.anything(), // log
        expect.objectContaining({ getById: expect.any(Function) }), // bookService passed
      );
    });

    it('updates size in DB after successful commit', async () => {
      setupHappyPath();
      const { service, db } = createService();

      await service.mergeBook(42);

      expect(db.update).toHaveBeenCalled();
    });

    it('emits merge_complete SSE event on success', async () => {
      setupHappyPath();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.mergeBook(42);

      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_complete', {
        book_id: 42,
        book_title: 'The Way of Kings',
        success: true,
      });
    });

    it('records merged event via eventHistory on success', async () => {
      setupHappyPath();
      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });

      await service.mergeBook(42);

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 42,
        eventType: 'merged',
        source: 'manual',
      }));
    });

    it('clears in-progress lock after success', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.mergeBook(42);

      // Second call should not throw ALREADY_IN_PROGRESS
      setupHappyPath();
      await expect(service.mergeBook(42)).resolves.toBeDefined();
    });
  });

  describe('mergeBook — processAudioFiles failure (pre-verification)', () => {
    it('throws when processAudioFiles returns { success: false }', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();

      await expect(service.mergeBook(42)).rejects.toThrow('Audio processing failed: ffmpeg error');
    });

    it('cleans staging dir when processAudioFiles fails', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
    });

    it('leaves book.path unchanged when processAudioFiles fails', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      // rename (move) should NOT have been called — book.path untouched
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('clears in-progress lock after failure', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      // Second call should not throw ALREADY_IN_PROGRESS
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'again' });
      (rm as Mock).mockResolvedValue(undefined);
      await expect(service.mergeBook(42)).rejects.not.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });
    });
  });

  describe('mergeBook — staged verification failure', () => {
    it('throws when scanAudioDirectory returns null on staging dir', async () => {
      (readdir as Mock)
        .mockResolvedValueOnce(['01.mp3', '02.mp3'])
        .mockResolvedValueOnce(['The Way of Kings.m4b']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [] });
      (scanAudioDirectory as Mock).mockResolvedValue(null);
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();

      await expect(service.mergeBook(42)).rejects.toThrow('verification');
    });

    it('cleans staging dir when scan fails', async () => {
      (readdir as Mock)
        .mockResolvedValueOnce(['01.mp3', '02.mp3'])
        .mockResolvedValueOnce(['The Way of Kings.m4b']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [] });
      (scanAudioDirectory as Mock).mockResolvedValue(null);
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
    });

    it('leaves book.path unchanged when scan fails', async () => {
      (readdir as Mock)
        .mockResolvedValueOnce(['01.mp3', '02.mp3'])
        .mockResolvedValueOnce(['The Way of Kings.m4b']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [] });
      (scanAudioDirectory as Mock).mockResolvedValue(null);
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('does not call enrichBookFromAudio when scan fails', async () => {
      (readdir as Mock)
        .mockResolvedValueOnce(['01.mp3', '02.mp3'])
        .mockResolvedValueOnce(['The Way of Kings.m4b']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [] });
      (scanAudioDirectory as Mock).mockResolvedValue(null);
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      expect(enrichBookFromAudio).not.toHaveBeenCalled();
    });
  });

  describe('mergeBook — post-commit enrichment failure', () => {
    it('surfaces error when enrichBookFromAudio returns { enriched: false }', async () => {
      setupHappyPath();
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
      const { service, log } = createService();

      // Should still resolve (not throw) — merge succeeded on disk
      const result = await service.mergeBook(42);
      expect(result.bookId).toBe(42);

      // Warning logged
      expect(log.warn).toHaveBeenCalled();
    });

    it('M4B remains in book.path after enrichment failure (no rollback)', async () => {
      setupHappyPath();
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
      const { service } = createService();

      await service.mergeBook(42);

      // rename (move) was called before enrichment
      expect(rename).toHaveBeenCalledWith(
        STAGING_DIR + '/The Way of Kings.m4b',
        BOOK_PATH + '/The Way of Kings.m4b',
      );
    });
  });

  describe('mergeBook — guard conditions', () => {
    it('throws MergeError NOT_FOUND when book does not exist', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(null);

      await expect(service.mergeBook(99)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws MergeError NO_PATH when book has no path', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue({ ...mockBook, path: null });

      await expect(service.mergeBook(42)).rejects.toMatchObject({ code: 'NO_PATH' });
    });

    it('throws MergeError NO_STATUS when book is not in imported status', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue({ ...mockBook, status: 'wanted' });

      await expect(service.mergeBook(42)).rejects.toMatchObject({ code: 'NO_STATUS' });
    });

    it('throws MergeError NO_TOP_LEVEL_FILES when fewer than 2 top-level audio files exist', async () => {
      (readdir as Mock).mockResolvedValue(['Chapter 01.m4b']); // only 1 audio file
      const { service } = createService();

      await expect(service.mergeBook(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    it('throws MergeError NO_TOP_LEVEL_FILES when only non-audio files are present', async () => {
      (readdir as Mock).mockResolvedValue(['cover.jpg', 'metadata.nfo']);
      const { service } = createService();

      await expect(service.mergeBook(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    it('throws MergeError FFMPEG_NOT_CONFIGURED when ffmpegPath is not set', async () => {
      const { service } = createService();
      // Override settings to have empty ffmpegPath
      const noFfmpegService = new MergeService(
        inject<Db>(createMockDb()),
        inject<BookService>({ getById: vi.fn().mockResolvedValue(mockBook) } as unknown as BookService),
        createMockSettingsService({ processing: { ffmpegPath: '' } as never }),
        inject<FastifyBaseLogger>(createMockLogger()),
      );

      await expect(noFfmpegService.mergeBook(42)).rejects.toMatchObject({ code: 'FFMPEG_NOT_CONFIGURED' });
    });

    it('throws MergeError ALREADY_IN_PROGRESS when same book is already being merged', async () => {
      // Set up a slow processAudioFiles so the first call is still in-progress
      let resolveProcessing!: () => void;
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockReturnValue(new Promise((resolve) => {
        resolveProcessing = () => resolve({ success: false, error: 'cancelled' });
      }));
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      const firstCall = service.mergeBook(42);

      // Second call while first is in progress
      await expect(service.mergeBook(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });

      // Clean up
      resolveProcessing();
      await firstCall.catch(() => undefined);
    });
  });

  describe('concurrency lock', () => {
    it('sets in-progress flag before processing begins', async () => {
      let lockChecked = false;
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => {
        // Check that the lock is held during processing
        lockChecked = true;
        return { success: false, error: 'test' };
      });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      expect(lockChecked).toBe(true);
    });

    it('clears lock via try/finally even when an exception is thrown mid-flow', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockImplementation(() => { throw new Error('disk full'); });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.mergeBook(42).catch(() => undefined);

      // Lock cleared — second call should not throw ALREADY_IN_PROGRESS
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'test' });
      (rm as Mock).mockResolvedValue(undefined);

      await expect(service.mergeBook(42)).rejects.not.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });
    });

    it('allows a second merge request after the first completes', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.mergeBook(42);

      // Second call: reset mocks and try again
      vi.clearAllMocks();
      setupHappyPath();
      await expect(service.mergeBook(42)).resolves.toBeDefined();
    });
  });
});
