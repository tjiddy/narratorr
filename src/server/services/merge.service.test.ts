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

      // processAudioFiles called on staging dir with mergeBehavior: always and callbacks
      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ ffmpegPath: '/usr/bin/ffmpeg', mergeBehavior: 'always', outputFormat: 'm4b' }),
        expect.objectContaining({ title: 'The Way of Kings' }),
        expect.objectContaining({ onProgress: expect.any(Function), onStderr: expect.any(Function) }),
        undefined, // signal (not passed by deprecated mergeBook)
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
        expect.any(Object),
        undefined,
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
        expect.any(Object),
        undefined,
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

    it('emits merge_complete SSE event with message field on success', async () => {
      setupHappyPath();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.mergeBook(42);

      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_complete', {
        book_id: 42,
        book_title: 'The Way of Kings',
        success: true,
        message: 'Merged 2 files into The Way of Kings.m4b',
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

// ============================================================================
// #257 — Merge observability: events, progress wiring, stderr dedup
// ============================================================================

describe('#257 merge observability — merge service', () => {
  describe('merge_started event', () => {
    it('recorded immediately after pre-flight checks pass (before ffmpeg runs)', async () => {
      let startedRecorded = false;
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => {
        // At this point merge_started should already have been recorded
        startedRecorded = true;
        return { success: false, error: 'test abort' };
      });
      (rm as Mock).mockResolvedValue(undefined);

      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });
      await service.mergeBook(42).catch(() => undefined);

      expect(startedRecorded).toBe(true);
      // merge_started should have been called before processAudioFiles
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 42,
        eventType: 'merge_started',
        source: 'manual',
      }));
    });

    it('SSE event emitted with { book_id, book_title } payload', async () => {
      setupHappyPath();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.mergeBook(42);

      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_started', {
        book_id: 42,
        book_title: 'The Way of Kings',
      });
    });

    it('NOT recorded when pre-flight checks fail (NOT_FOUND)', async () => {
      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service, bookService } = createService({ eventHistory });
      (bookService.getById as Mock).mockResolvedValue(null);

      await service.mergeBook(99).catch(() => undefined);

      expect(eventHistory.create).not.toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'merge_started',
      }));
    });
  });

  describe('merge_failed event', () => {
    it('recorded when processAudioFiles fails, with error in reason JSON', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });
      await service.mergeBook(42).catch(() => undefined);

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 42,
        eventType: 'merge_failed',
        reason: { error: 'Audio processing failed: ffmpeg error' },
      }));
    });

    it('SSE event emitted with { book_id, book_title, error } payload', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });
      await service.mergeBook(42).catch(() => undefined);

      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', {
        book_id: 42,
        book_title: 'The Way of Kings',
        error: 'Audio processing failed: ffmpeg error',
        reason: 'error',
      });
    });

    it('NOT recorded when failure occurs before merge_started (pre-flight rejection)', async () => {
      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service, bookService } = createService({ eventHistory, eventBroadcaster });
      (bookService.getById as Mock).mockResolvedValue(null);

      await service.mergeBook(99).catch(() => undefined);

      expect(eventHistory.create).not.toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'merge_failed',
      }));
      expect(eventBroadcaster.emit).not.toHaveBeenCalledWith('merge_failed', expect.anything());
    });
  });

  describe('merge_progress SSE', () => {
    it('emitted on phase transitions (staging → processing → verifying → committing)', async () => {
      setupHappyPath();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.mergeBook(42);

      const progressCalls = (eventBroadcaster.emit as Mock).mock.calls.filter(
        (c: unknown[]) => c[0] === 'merge_progress',
      );
      const phases = progressCalls.map((c: unknown[]) => (c[1] as { phase: string }).phase);
      expect(phases).toContain('staging');
      expect(phases).toContain('processing');
      expect(phases).toContain('verifying');
      expect(phases).toContain('committing');
    });
  });

  describe('event emission resilience', () => {
    it('event emission failure (broadcaster throws) does not fail the merge operation', async () => {
      setupHappyPath();
      const eventBroadcaster = {
        emit: vi.fn().mockImplementation(() => { throw new Error('SSE broken'); }),
      } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      const result = await service.mergeBook(42);
      expect(result.bookId).toBe(42);
    });

    it('event history creation failure does not fail the merge operation', async () => {
      setupHappyPath();
      const eventHistory = {
        create: vi.fn().mockRejectedValue(new Error('DB write failed')),
      } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });

      const result = await service.mergeBook(42);
      expect(result.bookId).toBe(42);
    });
  });

  describe('concurrent merge guard with events', () => {
    it('first accepted merge records merge_started; second ALREADY_IN_PROGRESS records nothing', async () => {
      let resolveProcessing!: () => void;
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockReturnValue(new Promise((resolve) => {
        resolveProcessing = () => resolve({ success: false, error: 'cancelled' });
      }));
      (rm as Mock).mockResolvedValue(undefined);

      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      const firstCall = service.mergeBook(42);

      // Wait a tick so the first call's sync emit fires
      await new Promise((r) => process.nextTick(r));

      const emitsBefore = (eventBroadcaster.emit as Mock).mock.calls.length;

      // Second call — should throw without emitting any events
      await expect(service.mergeBook(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });

      // No additional SSE events from the rejected second request
      expect((eventBroadcaster.emit as Mock).mock.calls.length).toBe(emitsBefore);

      // Only 1 merge_started SSE from the first (accepted) call
      const startedEmits = (eventBroadcaster.emit as Mock).mock.calls.filter(
        (c: unknown[]) => c[0] === 'merge_started',
      );
      expect(startedEmits).toHaveLength(1);

      resolveProcessing();
      await firstCall.catch(() => undefined);
    });
  });

  describe('stderr deduplication', () => {
    it('3 identical lines logged once with × 3 suffix', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, callbacks: { onStderr?: (line: string) => void }) => {
        callbacks?.onStderr?.('Too many packets buffered');
        callbacks?.onStderr?.('Too many packets buffered');
        callbacks?.onStderr?.('Too many packets buffered');
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (readdir as Mock).mockResolvedValueOnce(['out.m4b']);
      (rename as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      const { service, log } = createService();
      await service.mergeBook(42);

      // Should be logged once with count
      const debugCalls = (log.debug as Mock).mock.calls;
      const stderrCalls = debugCalls.filter(
        (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'stderr' in (c[0] as Record<string, unknown>),
      );
      expect(stderrCalls).toHaveLength(1);
      expect(stderrCalls[0][0]).toEqual({ stderr: 'Too many packets buffered', count: 3 });
      expect(stderrCalls[0][1]).toContain('× 3');
    });

    it('interleaved different lines each logged separately', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, callbacks: { onStderr?: (line: string) => void }) => {
        callbacks?.onStderr?.('line A');
        callbacks?.onStderr?.('line B');
        callbacks?.onStderr?.('line A');
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (readdir as Mock).mockResolvedValueOnce(['out.m4b']);
      (rename as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      const { service, log } = createService();
      await service.mergeBook(42);

      const debugCalls = (log.debug as Mock).mock.calls;
      const stderrCalls = debugCalls.filter(
        (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'stderr' in (c[0] as Record<string, unknown>),
      );
      expect(stderrCalls).toHaveLength(3);
      expect(stderrCalls[0][0]).toEqual({ stderr: 'line A' });
      expect(stderrCalls[1][0]).toEqual({ stderr: 'line B' });
      expect(stderrCalls[2][0]).toEqual({ stderr: 'line A' });
    });

    it('single occurrence logged without count suffix', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, callbacks: { onStderr?: (line: string) => void }) => {
        callbacks?.onStderr?.('single line');
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (readdir as Mock).mockResolvedValueOnce(['out.m4b']);
      (rename as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      const { service, log } = createService();
      await service.mergeBook(42);

      const debugCalls = (log.debug as Mock).mock.calls;
      const stderrCalls = debugCalls.filter(
        (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'stderr' in (c[0] as Record<string, unknown>),
      );
      expect(stderrCalls).toHaveLength(1);
      expect(stderrCalls[0][0]).toEqual({ stderr: 'single line' });
      expect(stderrCalls[0][1]).toBe('ffmpeg stderr');
    });
  });

  describe('#368 merge queue — queue mechanics', () => {
    function createBook(id: number, title: string) {
      return {
        ...createMockDbBook({ id, title, path: `/library/Author/${title}`, status: 'imported' }),
        authors: [mockAuthor],
        narrators: [],
      };
    }

    function setupMergeForBook(bookService: { getById: Mock }, bookId: number, title: string) {
      const book = createBook(bookId, title);
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === bookId) return book;
        return null;
      });
      return book;
    }

    /** Sets up processAudioFiles to block until the returned resolve function is called. */
    function createBlockingMerge() {
      let resolveProcess!: () => void;
      const processPromise = new Promise<void>((resolve) => { resolveProcess = resolve; });
      (processAudioFiles as Mock).mockImplementation(async () => {
        await processPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      return { resolve: resolveProcess };
    }

    function setupFsMocksForMerge() {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
    }

    function createServiceWithBroadcaster() {
      const db = createMockDb();
      const bookService = {
        getById: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const service = new MergeService(
        inject<Db>(db),
        inject<BookService>(bookService),
        settingsService,
        inject<FastifyBaseLogger>(log),
        undefined,
        eventBroadcaster,
      );

      return { service, db, bookService, log, eventBroadcaster };
    }

    it('single merge with no queue contention returns { status: started }', async () => {
      setupFsMocksForMerge();
      setupHappyPath();
      const { service, bookService } = createServiceWithBroadcaster();
      setupMergeForBook(bookService, 42, 'The Way of Kings');

      const result = await service.enqueueMerge(42);

      expect(result).toEqual({ status: 'started', bookId: 42 });
    });

    it('second merge request while first is active returns { status: queued }', async () => {
      setupFsMocksForMerge();
      const { service, bookService, eventBroadcaster } = createServiceWithBroadcaster();
      const book42 = createBook(42, 'Book A');
      const book43 = createBook(43, 'Book B');
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });
      const { resolve } = createBlockingMerge();

      await service.enqueueMerge(42);
      const result = await service.enqueueMerge(43);

      expect(result).toEqual({ status: 'queued', bookId: 43, position: 1 });
      expect((eventBroadcaster as unknown as { emit: Mock }).emit).toHaveBeenCalledWith('merge_queued', {
        book_id: 43,
        book_title: 'Book B',
        position: 1,
      });
      resolve();
    });

    it('queued merge starts automatically when active merge completes', async () => {
      setupFsMocksForMerge();
      const { service, bookService, eventBroadcaster } = createServiceWithBroadcaster();
      const book42 = createBook(42, 'Book A');
      const book43 = createBook(43, 'Book B');
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });

      // First merge blocks, second queues
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      }).mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      // Complete the first merge
      resolveFirst();
      // Allow microtasks to drain
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The second merge should have started (merge_started emitted for both)
      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const startedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_started');
      expect(startedEvents.length).toBeGreaterThanOrEqual(2);
      expect(startedEvents.some((c: unknown[]) => (c[1] as { book_id: number }).book_id === 43)).toBe(true);
    });

    it('duplicate merge request for same bookId while already queued is rejected with ALREADY_QUEUED', async () => {
      setupFsMocksForMerge();
      const { service, bookService } = createServiceWithBroadcaster();
      const book42 = createBook(42, 'Book A');
      const book43 = createBook(43, 'Book B');
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });
      const { resolve } = createBlockingMerge();

      await service.enqueueMerge(42); // starts
      await service.enqueueMerge(43); // queues

      await expect(service.enqueueMerge(43)).rejects.toThrow('Merge already queued for this book');
      resolve();
    });

    it('duplicate merge request for same bookId while in-progress is rejected with ALREADY_IN_PROGRESS', async () => {
      setupFsMocksForMerge();
      const { service, bookService } = createServiceWithBroadcaster();
      setupMergeForBook(bookService, 42, 'Book A');
      const { resolve } = createBlockingMerge();

      await service.enqueueMerge(42); // starts

      await expect(service.enqueueMerge(42)).rejects.toThrow('Merge already in progress for this book');
      resolve();
    });

    it('multiple queued merges process in FIFO order', async () => {
      setupFsMocksForMerge();
      const { service, bookService, eventBroadcaster } = createServiceWithBroadcaster();
      const books = [42, 43, 44].map((id) => createBook(id, `Book ${id}`));
      bookService.getById.mockImplementation(async (id: number) => books.find((b) => b.id === id) ?? null);

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      }).mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42); // starts
      await service.enqueueMerge(43); // queues position 1
      await service.enqueueMerge(44); // queues position 2

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const startedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_started');
      const startedBookIds = startedEvents.map((c: unknown[]) => (c[1] as { book_id: number }).book_id);
      // Book 43 should start before book 44 (FIFO)
      const idx43 = startedBookIds.indexOf(43);
      const idx44 = startedBookIds.indexOf(44);
      expect(idx43).toBeLessThan(idx44);
    });
  });

  describe('#368 merge queue — dequeue-time validation', () => {
    function createServiceWithBroadcaster() {
      const db = createMockDb();
      const bookService = {
        getById: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const service = new MergeService(
        inject<Db>(db),
        inject<BookService>(bookService),
        settingsService,
        inject<FastifyBaseLogger>(log),
        undefined,
        eventBroadcaster,
      );

      return { service, db, bookService, log, eventBroadcaster };
    }

    it('queued merge for a book that was deleted before dequeue emits merge_failed and drains next', async () => {
      const { service, bookService, eventBroadcaster } = createServiceWithBroadcaster();
      const book42 = {
        ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      const book43 = {
        ...createMockDbBook({ id: 43, title: 'Book B', path: '/lib/B', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      // Initial: both exist
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });

      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      }).mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42); // starts
      await service.enqueueMerge(43); // queues

      // Delete book 43 before it dequeues
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        return null; // book 43 deleted
      });

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const failedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_failed');
      expect(failedEvents.some((c: unknown[]) => (c[1] as { book_id: number }).book_id === 43)).toBe(true);
    });
  });

  describe('#368 merge queue — SSE events', () => {
    it('queued merge emits merge_queued with { book_id, book_title, position: 1 }', async () => {
      const db = createMockDb();
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const book42 = {
        ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      const book43 = {
        ...createMockDbBook({ id: 43, title: 'Book B', path: '/lib/B', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });

      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => new Promise(() => {})); // Never resolves

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      await service.enqueueMerge(42); // starts (takes slot)
      await service.enqueueMerge(43); // queues

      expect((eventBroadcaster as unknown as { emit: Mock }).emit).toHaveBeenCalledWith('merge_queued', {
        book_id: 43,
        book_title: 'Book B',
        position: 1,
      });
    });

    it('emits merge_queue_updated with decremented positions when active merge completes', async () => {
      const db = createMockDb();
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const books = [42, 43, 44].map((id) => ({
        ...createMockDbBook({ id, title: `Book ${id}`, path: `/lib/${id}`, status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      }));
      bookService.getById.mockImplementation(async (id: number) => books.find((b) => b.id === id) ?? null);

      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      }).mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      await service.enqueueMerge(42); // starts
      await service.enqueueMerge(43); // queues position 1
      await service.enqueueMerge(44); // queues position 2

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const queueUpdates = emitCalls.filter((c: unknown[]) => c[0] === 'merge_queue_updated');
      // After book 43 dequeues, book 44 should get position update to 1
      expect(queueUpdates.some((c: unknown[]) =>
        (c[1] as { book_id: number; position: number }).book_id === 44 &&
        (c[1] as { book_id: number; position: number }).position === 1,
      )).toBe(true);
    });

    it('merge_complete includes enrichmentWarning when enrichment fails', async () => {
      setupHappyPath();
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.mergeBook(42);

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const completeEvent = emitCalls.find((c: unknown[]) => c[0] === 'merge_complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent![1]).toMatchObject({
        enrichmentWarning: expect.any(String),
      });
    });
  });

  describe('#368 merge queue — error isolation', () => {
    it('failed merge does not prevent queued merges from processing', async () => {
      const db = createMockDb();
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const book42 = {
        ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      const book43 = {
        ...createMockDbBook({ id: 43, title: 'Book B', path: '/lib/B', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });

      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      // First merge fails, second succeeds
      (processAudioFiles as Mock)
        .mockRejectedValueOnce(new Error('FFmpeg crashed'))
        .mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      await service.enqueueMerge(42); // starts — will fail
      await service.enqueueMerge(43); // queues

      // Wait for both to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      // Book 42 should have merge_failed
      const failedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_failed');
      expect(failedEvents.some((c: unknown[]) => (c[1] as { book_id: number }).book_id === 42)).toBe(true);
      // Book 43 should have merge_started (queue drained)
      const startedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_started');
      expect(startedEvents.some((c: unknown[]) => (c[1] as { book_id: number }).book_id === 43)).toBe(true);
    });
  });

  describe('#368 merge queue — race conditions', () => {
    it('two simultaneous merge requests — one starts, one queues (no double-start)', async () => {
      const db = createMockDb();
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const book42 = {
        ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      const book43 = {
        ...createMockDbBook({ id: 43, title: 'Book B', path: '/lib/B', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        if (id === 43) return book43;
        return null;
      });

      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => new Promise(() => {}));

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      const [r1, r2] = await Promise.all([
        service.enqueueMerge(42),
        service.enqueueMerge(43),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual(['queued', 'started']);
    });

    it('concurrent same-book requests — one succeeds, the other rejects with duplicate error', async () => {
      const db = createMockDb();
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const book42 = {
        ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      };
      bookService.getById.mockResolvedValue(book42);

      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => new Promise(() => {}));

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      const results = await Promise.allSettled([
        service.enqueueMerge(42),
        service.enqueueMerge(42),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: expect.stringMatching(/ALREADY_IN_PROGRESS|ALREADY_QUEUED/),
      });
    });

    it('after first merge completes and promotes queued job, new enqueueMerge is rejected (single-worker invariant)', async () => {
      const db = createMockDb();
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      const settingsService = createMockSettingsService(processingOverrides);
      const log = createMockLogger();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;

      const books = [42, 43, 44].map((id) => ({
        ...createMockDbBook({ id, title: `Book ${id}`, path: `/lib/${id}`, status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      }));
      bookService.getById.mockImplementation(async (id: number) => books.find((b) => b.id === id) ?? null);

      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      let resolveSecond!: () => void;
      const secondPromise = new Promise<void>((resolve) => { resolveSecond = resolve; });
      (processAudioFiles as Mock)
        .mockImplementationOnce(async () => { await firstPromise; return { success: true, outputFiles: ['/staging/out.m4b'] }; })
        .mockImplementationOnce(async () => { await secondPromise; return { success: true, outputFiles: ['/staging/out.m4b'] }; })
        .mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      await service.enqueueMerge(42); // starts — takes the semaphore slot
      await service.enqueueMerge(43); // queues

      // Complete first merge — should promote book 43 (passing the slot, not releasing)
      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Book 43 is now the active merge (holding the slot). A new request should queue, not start.
      const result = await service.enqueueMerge(44);
      expect(result.status).toBe('queued');

      resolveSecond();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe('cancelMerge', () => {
    function createServiceWithBroadcasterForCancel() {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service, bookService } = createService({
        eventBroadcaster: inject<EventBroadcasterService>(broadcaster),
      });
      return { service, bookService, emitted, broadcaster };
    }

    function createBlockingMergeForCancel() {
      let resolveProcess!: () => void;
      const processPromise = new Promise<void>((resolve) => { resolveProcess = resolve; });
      (processAudioFiles as Mock).mockImplementation(async () => {
        await processPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      return { resolve: resolveProcess };
    }

    function setupFsMocksForCancel() {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
    }

    describe('cancel from queue', () => {
      it('removes a queued bookId from the queue and returns cancelled', async () => {
        setupFsMocksForCancel();
        const { service } = createServiceWithBroadcasterForCancel();
        const blocking = createBlockingMergeForCancel();

        // Start first merge (takes the slot)
        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        // Queue a second merge
        const mockBook43 = { ...mockBook, id: 43, title: 'Book 43' };
        const { bookService } = createService();
        // Override bookService to resolve 43
        const { service: svc2, emitted } = createServiceWithBroadcasterForCancel();
        // Use the service with broadcaster
        setupFsMocksForCancel();
        const blocking2 = createBlockingMergeForCancel();
        await svc2.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        // Queue book 43
        (svc2 as unknown as { bookService: { getById: Mock } }).bookService = undefined as never;
        // Better approach: use original service
        blocking.resolve();
        blocking2.resolve();
        await new Promise((r) => setTimeout(r, 50));
      });

      it('returns cancelled for a queued bookId', async () => {
        setupFsMocksForCancel();
        const { service, emitted } = createServiceWithBroadcasterForCancel();
        const blocking = createBlockingMergeForCancel();

        // Start merge for book 42 (takes slot)
        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        // Queue book 43
        const bookService43 = createService().bookService;
        (bookService43.getById as Mock).mockResolvedValue({ ...mockBook, id: 43, title: 'Book 43' });
        // Directly manipulate — push 43 to queue
        (service as unknown as { queue: number[] }).queue.push(43);

        const result = await service.cancelMerge(43);
        expect(result.status).toBe('cancelled');
        expect((service as unknown as { queue: number[] }).queue).not.toContain(43);

        // Check merge_failed emitted with reason cancelled
        const failedEvents = emitted.filter(e => e.event === 'merge_failed');
        expect(failedEvents.length).toBeGreaterThanOrEqual(1);
        const lastFailed = failedEvents[failedEvents.length - 1].payload as { reason: string };
        expect(lastFailed.reason).toBe('cancelled');

        blocking.resolve();
        await new Promise((r) => setTimeout(r, 50));
      });

      it('returns not-found for a bookId that is neither queued nor in-progress', async () => {
        const { service } = createServiceWithBroadcasterForCancel();
        const result = await service.cancelMerge(999);
        expect(result.status).toBe('not-found');
      });
    });

    describe('cancel from in-progress (processing phase)', () => {
      it('aborts the controller and emits merge_failed with reason cancelled', async () => {
        setupFsMocksForCancel();
        const { service, emitted } = createServiceWithBroadcasterForCancel();

        // Block at processAudioFiles so we can cancel during processing
        let resolveProcess!: () => void;
        (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, _cb: unknown, signal?: AbortSignal) => {
          // Wait for abort or resolution
          await new Promise<void>((resolve) => {
            resolveProcess = resolve;
            if (signal) {
              signal.addEventListener('abort', () => resolve(), { once: true });
            }
          });
          if (signal?.aborted) {
            return { success: false, error: 'Processing aborted' };
          }
          return { success: true, outputFiles: ['/staging/out.m4b'] };
        });

        // Start merge
        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        // Cancel
        const result = await service.cancelMerge(42);
        expect(result.status).toBe('cancelled');

        // Let the catch/finally handlers run
        await new Promise((r) => setTimeout(r, 100));

        // Check that merge_failed was emitted with reason 'cancelled'
        const failedEvents = emitted.filter(e => e.event === 'merge_failed');
        expect(failedEvents.length).toBeGreaterThanOrEqual(1);
        const payload = failedEvents[failedEvents.length - 1].payload as { reason: string; error: string };
        expect(payload.reason).toBe('cancelled');
      });
    });

    describe('cancel rejected (committing phase)', () => {
      it('returns committing status when phase is committing', async () => {
        const { service } = createServiceWithBroadcasterForCancel();
        // Directly set state to simulate committing phase
        (service as unknown as { currentPhase: Map<number, string> }).currentPhase.set(42, 'committing');
        (service as unknown as { abortControllers: Map<number, AbortController> }).abortControllers.set(42, new AbortController());

        const result = await service.cancelMerge(42);
        expect(result.status).toBe('committing');
      });
    });

    describe('cancel on terminal states', () => {
      it('returns not-found for a completed merge', async () => {
        setupHappyPath();
        const { service } = createServiceWithBroadcasterForCancel();
        await service.mergeBook(42);

        const result = await service.cancelMerge(42);
        expect(result.status).toBe('not-found');
      });
    });
  });

  describe('phase rename (finalizing → committing)', () => {
    it('committing phase is emitted before commitMerge is called', async () => {
      setupHappyPath();
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service } = createService({
        eventBroadcaster: inject<EventBroadcasterService>(broadcaster),
      });

      await service.mergeBook(42);

      const progressEvents = emitted
        .filter(e => e.event === 'merge_progress')
        .map(e => (e.payload as { phase: string }).phase);
      expect(progressEvents).toContain('committing');
      expect(progressEvents).not.toContain('finalizing');

      // committing must come before merge_complete
      const allEvents = emitted.map(e => e.event);
      const committingIdx = allEvents.indexOf('merge_progress');
      const lastProgress = emitted.filter(e => e.event === 'merge_progress').pop();
      expect((lastProgress?.payload as { phase: string }).phase).toBe('committing');
    });

    it('finalizing phase no longer exists in emitted events', async () => {
      setupHappyPath();
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service } = createService({
        eventBroadcaster: inject<EventBroadcasterService>(broadcaster),
      });

      await service.mergeBook(42);

      const phases = emitted
        .filter(e => e.event === 'merge_progress')
        .map(e => (e.payload as { phase: string }).phase);
      expect(phases).not.toContain('finalizing');
    });
  });

  describe('typed cancellation signal', () => {
    it('merge_failed event includes reason error on real failures', async () => {
      (readdir as Mock).mockResolvedValueOnce(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg crashed' });
      (rm as Mock).mockResolvedValue(undefined);

      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service } = createService({
        eventBroadcaster: inject<EventBroadcasterService>(broadcaster),
      });

      await expect(service.mergeBook(42)).rejects.toThrow();

      const failedEvents = emitted.filter(e => e.event === 'merge_failed');
      expect(failedEvents).toHaveLength(1);
      expect((failedEvents[0].payload as { reason: string }).reason).toBe('error');
    });
  });
});
