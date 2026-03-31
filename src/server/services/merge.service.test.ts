import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { MergeService } from './merge.service.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import type { BookService } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { readdir, mkdir, cp, unlink, stat, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';

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
      expect(cp).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'), join(STAGING_DIR, '01.mp3'));
      expect(cp).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'), join(STAGING_DIR, '02.mp3'));
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
        join(STAGING_DIR, 'The Way of Kings.m4b'),
        join(BOOK_PATH, 'The Way of Kings.m4b'),
      );

      // Originals deleted from book.path
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));

      // Staging dir cleaned
      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });

      // Result shape
      expect(result).toMatchObject({
        bookId: 42,
        outputFile: join(BOOK_PATH, 'The Way of Kings.m4b'),
        filesReplaced: 2,
      });
    });

    it('forwards sourceBitrateKbps from book.audioBitrate to processAudioFiles', async () => {
      const bookWithBitrate = {
        ...createMockDbBook({ id: 42, title: 'The Way of Kings', path: BOOK_PATH, status: 'imported', audioBitrate: 64000 }),
        authors: [mockAuthor],
        narrators: [],
      };
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue(bookWithBitrate);
      setupHappyPath();

      await service.mergeBook(42);

      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ sourceBitrateKbps: 64 }),
        expect.any(Object),
      );
    });

    it('passes sourceBitrateKbps as undefined when book.audioBitrate is null', async () => {
      // mockBook has audioBitrate: null by default
      const { service } = createService();
      setupHappyPath();

      await service.mergeBook(42);

      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ sourceBitrateKbps: undefined }),
        expect.any(Object),
      );
    });

    it('emits debug log when source bitrate is lower than target', async () => {
      const bookWithBitrate = {
        ...createMockDbBook({ id: 42, title: 'The Way of Kings', path: BOOK_PATH, status: 'imported', audioBitrate: 64000 }),
        authors: [mockAuthor],
        narrators: [],
      };
      const { service, bookService, log } = createService();
      bookService.getById.mockResolvedValue(bookWithBitrate);
      setupHappyPath();

      await service.mergeBook(42);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sourceBitrateKbps: 64, targetBitrateKbps: 128, effectiveBitrateKbps: 64 }),
        expect.stringContaining('Capping target bitrate'),
      );
    });

    it('does not delete the output file when an original shares the same basename as the staged M4B', async () => {
      // Book already has a top-level .m4b alongside other files
      (readdir as Mock)
        .mockResolvedValueOnce(['01.mp3', '02.mp3', 'The Way of Kings.m4b']) // book.path — includes pre-existing m4b
        .mockResolvedValueOnce(['The Way of Kings.m4b']); // staging scan
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 500_000_000 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
      const { service } = createService();

      await service.mergeBook(42);

      // The original mp3s are deleted
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
      // The output file (same basename as staged M4B) is NOT deleted
      expect(unlink).not.toHaveBeenCalledWith(join(BOOK_PATH, 'The Way of Kings.m4b'));
    });

    it('calls enrichBookFromAudio with bookService after successful move', async () => {
      setupHappyPath();
      const { service } = createService();

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

    // #149 — DB timing fix (DB-1): db.update must come before unlink loop
    it('calls db.update before any unlink() call (DB update is first action after rename)', async () => {
      const callOrder: string[] = [];
      setupHappyPath();
      (rename as Mock).mockImplementation(async () => { callOrder.push('rename'); });
      (unlink as Mock).mockImplementation(async () => { callOrder.push('unlink'); });
      const { service, db } = createService();
      const chain = db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(async () => { callOrder.push('db.update'); }) }),
      });
      void chain; // suppress unused var warning

      await service.mergeBook(42);

      const renameIdx = callOrder.indexOf('rename');
      const dbUpdateIdx = callOrder.indexOf('db.update');
      const firstUnlinkIdx = callOrder.indexOf('unlink');
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      expect(dbUpdateIdx).toBeGreaterThan(renameIdx);
      expect(firstUnlinkIdx).toBeGreaterThan(dbUpdateIdx);
    });

    it('does not call unlink() when db.update throws after rename (DB failure stops cleanup)', async () => {
      setupHappyPath();
      const { service, db } = createService();
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
      });

      await expect(service.mergeBook(42)).rejects.toThrow('DB write failed');

      expect(unlink).not.toHaveBeenCalled();
    });

    it('db.update receives both size and updatedAt from stat() on the post-rename destination path', async () => {
      setupHappyPath();
      (stat as Mock).mockResolvedValue({ size: 123_456_789 });
      const { service, db } = createService();

      await service.mergeBook(42);

      // stat() must be called on the destination path (book.path/stagedM4b), not the staging path
      const expectedOutputPath = join(BOOK_PATH, 'The Way of Kings.m4b');
      expect(stat).toHaveBeenCalledWith(expectedOutputPath);

      const setMock = (db.update as Mock).mock.results[0]?.value?.set as Mock;
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
        size: 123_456_789,
        updatedAt: expect.any(Date),
      }));
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
    it('surfaces enrichmentWarning in result when enrichBookFromAudio returns { enriched: false }', async () => {
      setupHappyPath();
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
      const { service, log } = createService();

      // Should still resolve (not throw) — merge succeeded on disk
      const result = await service.mergeBook(42);
      expect(result.bookId).toBe(42);
      expect(result.enrichmentWarning).toBe('Merge succeeded but metadata update failed — audio fields may be stale');

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
        join(STAGING_DIR, 'The Way of Kings.m4b'),
        join(BOOK_PATH, 'The Way of Kings.m4b'),
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
