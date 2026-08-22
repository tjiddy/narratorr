import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { MergeService, clampConcurrency } from './merge.service.js';
import { processAudioFiles } from '@core/utils/audio-processor.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudioWithinAdmissionLock } from './enrichment-utils.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
import { RetagError, type TaggingService, type RetagResult } from './tagging.service.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { readdir, mkdir, cp, unlink, stat, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { books } from '@db/schema.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';

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

const { ffmpegState } = vi.hoisted(() => ({ ffmpegState: { resolves: true } }));
vi.mock('@core/utils/audio-processor.js', () => ({
  processAudioFiles: vi.fn(),
  // Plain arrow preserves the hoisted gate toggle across vi.clearAllMocks().
  resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null),
}));

// Use the real guard class so the operator-visible refusal string cannot drift.
const { InsufficientAudioFilesError } =
  await vi.importActual<typeof import('@core/utils/audio-processor.js')>('@core/utils/audio-processor.js');

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudioWithinAdmissionLock: vi.fn(),
}));

// Mocked fs short-circuits marker recovery; merge.service.marker.test.ts covers real disk behavior (#1418).
vi.mock('../utils/recover-interrupted-commit.js', () => ({
  recoverInterruptedCommit: vi.fn().mockResolvedValue(undefined),
}));

import { withBookAdmissionLock, hasPendingBookAdmission } from './book-admission.js';
import {
  BOOK_PATH, STAGING_DIR, mockAuthor, mockBook, processingOverrides, SCAN_RESULT,
  settle, setupHappyPath, setupBlockingMerge, deferred, createMergeHarness,
} from './__tests__/merge-fixtures.js';

function createService(opts?: {
  eventHistory?: EventHistoryService;
  eventBroadcaster?: EventBroadcasterService;
  connector?: { notifyRefresh: ReturnType<typeof vi.fn> };
  processing?: Partial<{ outputFormat: 'm4b' | 'mp3'; bitrate: number; keepOriginalBitrate: boolean; maxConcurrentProcessing: number }>;
  tagging?: Partial<{ enabled: boolean; mode: 'populate_missing' | 'overwrite'; embedCover: boolean }>;
  /** Pass `null` to exercise "tag embedding enabled but no tagger wired" (AC10's absent arm). */
  taggingService?: { retagBookWithinAdmissionLock: ReturnType<typeof vi.fn> } | null;
}) {
  const db = createMockDb();
  const bookService = {
    getById: vi.fn().mockResolvedValue(mockBook),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const settingsService = createMockSettingsService({
    processing: { ...processingOverrides.processing, ...opts?.processing },
    ...(opts?.tagging && { tagging: opts.tagging }),
  });
  const log = createMockLogger();

  const service = new MergeService(
    inject<Db>(db),
    inject<BookService>(bookService),
    settingsService,
    inject<FastifyBaseLogger>(log),
    opts?.eventHistory,
    opts?.eventBroadcaster,
    opts?.connector ? inject<ConnectorService>(opts.connector) : undefined,
    opts?.taggingService ? inject<TaggingService>(opts.taggingService) : undefined,
  );

  return { service, db, bookService, log, settingsService, connector: opts?.connector, taggingService: opts?.taggingService };
}

describe('MergeService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('enqueueMerge — success path', () => {
    it('copies source files to staging dir, runs processAudioFiles on staging, verifies with scanAudioDirectory, moves M4B to book.path, deletes originals, cleans staging', async () => {
      setupHappyPath();
      const { service } = createService();

      const ack = await service.enqueueMerge(42);
      await settle();

      expect(ack).toEqual({ status: 'started', bookId: 42 });

      expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });

      expect(cp).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'), join(STAGING_DIR, '01.mp3'));
      expect(cp).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'), join(STAGING_DIR, '02.mp3'));
      expect(cp).not.toHaveBeenCalledWith(expect.stringContaining('cover.jpg'), expect.anything());

      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ ffmpegPath: '/usr/bin/ffmpeg', outputFormat: processingOverrides.processing.outputFormat }),
        expect.objectContaining({ title: 'The Way of Kings' }),
        expect.objectContaining({ onProgress: expect.any(Function), onStderr: expect.any(Function) }),
        expect.any(AbortSignal),
      );

      expect(scanAudioDirectory).toHaveBeenCalledWith(STAGING_DIR, {
        ffprobePath: '/usr/bin/ffprobe',
        onWarn: expect.any(Function),
        onDebug: expect.any(Function),
      });

      expect(rename).toHaveBeenCalledWith(
        join(STAGING_DIR, 'The Way of Kings.m4b'),
        join(BOOK_PATH, 'The Way of Kings.m4b'),
      );

      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));

      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
    });

    // Thread library naming tokens so merged files do not fall back to `${author} - ${title}` (#1720).
    it('threads library fileFormat + book-level tokens into the processAudioFiles context', async () => {
      setupHappyPath();
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue({
        ...mockBook,
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        editionLabel: 'Full Cast',
        narrators: [{ name: 'Michael Kramer' }],
        publishedDate: '2010-08-31',
      });

      await service.enqueueMerge(42);
      await settle();

      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.anything(),
        expect.objectContaining({
          fileFormat: '{author} - {title}',
          namingOptions: expect.objectContaining({ separator: 'space', case: 'default' }),
          bookTokens: expect.objectContaining({
            series: 'The Stormlight Archive',
            seriesPosition: 1,
            edition: 'Full Cast',
            narrator: 'Michael Kramer',
            year: '2010',
          }),
        }),
        expect.anything(),
        expect.any(AbortSignal),
      );
    });

    it('converges the commit-pending marker on bookPath before staging', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(recoverInterruptedCommit).toHaveBeenCalledWith(BOOK_PATH, expect.any(String), expect.anything());
      const recoverOrder = (recoverInterruptedCommit as Mock).mock.invocationCallOrder[0]!;
      const cpOrder = (cp as Mock).mock.invocationCallOrder[0]!;
      expect(recoverOrder).toBeLessThan(cpOrder);
    });

    // Born-hidden temps are neither eligibility evidence nor merge inputs (#1852).
    it('#1852: a dot-led temp beside the originals is not copied or deleted', async () => {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.m4b'];
        return ['01.mp3', '02.mp3', '.02.tmp.mp3', 'cover.jpg'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 500_000_000 });
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(cp).not.toHaveBeenCalledWith(expect.stringContaining('.02.tmp.mp3'), expect.anything());
      expect(unlink).not.toHaveBeenCalledWith(join(BOOK_PATH, '.02.tmp.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
    });

    // Reset deterministic staging before copy so crash residue cannot enter the merge (#1852).
    it('#1852: resets the staging dir (rm before the first copy)', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      const firstResetRm = (rm as Mock).mock.invocationCallOrder[0]!;
      const firstCp = (cp as Mock).mock.invocationCallOrder[0]!;
      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(firstResetRm).toBeLessThan(firstCp);
    });

    it('#1852: an un-emptyable staging dir aborts the merge via merge_failed (no copy/merge)', async () => {
      setupHappyPath();
      (rm as Mock).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(cp).not.toHaveBeenCalled();
      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42, reason: 'error' }));
    });

    it('aborts the merge (no staging, merge_failed) when recovery throws', async () => {
      setupHappyPath();
      (recoverInterruptedCommit as Mock).mockRejectedValueOnce(new Error('recovery failed'));
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      // Failure precedes runStaging, so catch must preserve any prior crash orphan in STAGING_DIR (#2099).
      expect(rm).not.toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42, reason: 'error' }));
    });

    // Recovery can shrink the set; execution must re-read and revalidate the two-file minimum (#1418).
    it('F9: a post-recovery audio set below the merge minimum aborts before staging', async () => {
      let bookPathReads = 0;
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return [];
        bookPathReads++;
        return bookPathReads === 1 ? ['01.mp3', '02.mp3'] : ['01.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42 }));
    });

    it('with outputFormat mp3: passes mp3 to processAudioFiles and discovers/commits the staged .mp3', async () => {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.mp3'];
        return ['01.mp3', '02.mp3', 'cover.jpg'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.mp3'] });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 500_000_000 });
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

      const { service } = createService({ processing: { outputFormat: 'mp3' } });

      await service.enqueueMerge(42);
      await settle();

      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ outputFormat: 'mp3' }),
        expect.any(Object),
        expect.any(Object),
        expect.any(AbortSignal),
      );

      expect(rename).toHaveBeenCalledWith(
        join(STAGING_DIR, 'The Way of Kings.mp3'),
        join(BOOK_PATH, 'The Way of Kings.mp3'),
      );
    });

    it('forwards onWarn/onDebug to MergeService log via scanAudioDirectory verify', async () => {
      setupHappyPath();
      const { service, log } = createService();

      await service.enqueueMerge(42);
      await settle();

      const options = (scanAudioDirectory as Mock).mock.calls[0]![1] as Parameters<typeof scanAudioDirectory>[1];
      expect(options?.onWarn).toEqual(expect.any(Function));
      expect(options?.onDebug).toEqual(expect.any(Function));

      options!.onWarn!('warn-msg', { warnPayload: 1 });
      expect(log.warn).toHaveBeenCalledWith({ warnPayload: 1 }, 'warn-msg');
      options!.onDebug!('debug-msg', { debugPayload: 2 });
      expect(log.debug).toHaveBeenCalledWith({ debugPayload: 2 }, 'debug-msg');
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

      await service.enqueueMerge(42);
      await settle();

      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ sourceBitrateKbps: 64 }),
        expect.any(Object),
        expect.any(Object),
        expect.any(AbortSignal),
      );
    });

    it('omits bitrate entirely when keepOriginalBitrate is set (128 must not leak)', async () => {
      const { service } = createService({ processing: { keepOriginalBitrate: true, bitrate: 128 } });
      setupHappyPath();

      await service.enqueueMerge(42);
      await settle();

      const config = vi.mocked(processAudioFiles).mock.calls[0]![1];
      expect(config).not.toHaveProperty('bitrate');
    });

    it('omits sourceBitrateKbps when book.audioBitrate is null', async () => {
      const { service } = createService();
      setupHappyPath();

      await service.enqueueMerge(42);
      await settle();

      // Exact optional contract requires absence, not explicit undefined (#939).
      expect(processAudioFiles).toHaveBeenCalled();
      const config = vi.mocked(processAudioFiles).mock.calls[0]![1];
      expect(config).not.toHaveProperty('sourceBitrateKbps');
    });

    it('does not delete the output file when an original shares the same basename as the staged M4B', async () => {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.m4b'];
        return ['01.mp3', '02.mp3', 'The Way of Kings.m4b'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 500_000_000 });
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
      expect(unlink).not.toHaveBeenCalledWith(join(BOOK_PATH, 'The Way of Kings.m4b'));
    });

    it('calls enrichBookFromAudioWithinAdmissionLock with bookService after successful move', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalledWith(
        42,
        BOOK_PATH,
        expect.objectContaining({ id: 42 }),
        expect.anything(), // db
        expect.anything(), // log
        expect.objectContaining({ getById: expect.any(Function) }), // bookService passed
        '/usr/bin/ffprobe', // ffprobePath derived from /usr/bin/ffmpeg
      );
    });

    it('updates size in DB after successful commit', async () => {
      setupHappyPath();
      const { service, db } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(db.update).toHaveBeenCalled();
    });

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

      await service.enqueueMerge(42);
      await settle();

      const renameIdx = callOrder.indexOf('rename');
      const dbUpdateIdx = callOrder.indexOf('db.update');
      const firstUnlinkIdx = callOrder.indexOf('unlink');
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      expect(dbUpdateIdx).toBeGreaterThan(renameIdx);
      expect(firstUnlinkIdx).toBeGreaterThan(dbUpdateIdx);
    });

    it('does not call unlink() when db.update throws after rename (DB failure stops cleanup)', async () => {
      setupHappyPath();
      const { service, db, log } = createService();
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
      });

      await service.enqueueMerge(42);
      await settle();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: expect.any(String) }) }),
        expect.stringContaining('Merge failed'),
        expect.anything(),
      );
      expect(unlink).not.toHaveBeenCalled();
    });

    it('db.update failure after rename — rename and stat are called, unlink is NOT called, error is logged', async () => {
      setupHappyPath();
      const { service, db, log } = createService();
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
      });

      await service.enqueueMerge(42);
      await settle();

      const expectedOutputPath = join(BOOK_PATH, 'The Way of Kings.m4b');
      expect(rename).toHaveBeenCalledWith(join(STAGING_DIR, 'The Way of Kings.m4b'), expectedOutputPath);
      expect(stat).toHaveBeenCalledWith(expectedOutputPath);
      expect(unlink).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: expect.any(String) }) }),
        expect.stringContaining('Merge failed'),
        expect.anything(),
      );
    });

    it('stat() failure after rename — db.update NOT called, unlink NOT called, error surfaces as merge failure', async () => {
      setupHappyPath();
      (stat as Mock).mockRejectedValue(new Error('stat failed'));
      const { service, db, log } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(rename).toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: expect.any(String) }) }),
        expect.stringContaining('Merge failed'),
        expect.anything(),
      );
    });

    it('unlink() failure on one original does not prevent cleanup of remaining originals', async () => {
      setupHappyPath();
      (unlink as Mock)
        .mockRejectedValueOnce(new Error('permission denied'))
        .mockResolvedValue(undefined);
      const { service, log } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(log.error).not.toHaveBeenCalled();
    });

    // Refresh belongs after the irreversible swap (#1707).
    describe('connector refresh', () => {
      it("enqueues exactly one 'merge' refresh after the originals-unlink swap", async () => {
        setupHappyPath();
        const notifyRefresh = vi.fn().mockResolvedValue(undefined);
        const { service } = createService({ connector: { notifyRefresh } });

        await service.enqueueMerge(42);
        await settle();

        expect(notifyRefresh).toHaveBeenCalledTimes(1);
        expect(notifyRefresh).toHaveBeenCalledWith('merge', [
          expect.objectContaining({ bookId: 42, title: 'The Way of Kings', libraryPath: BOOK_PATH }),
        ]);
      });

      it('still enqueues the refresh when the staging rm cleanup throws AFTER the swap', async () => {
        setupHappyPath();
        // First rm is staging reset; fail only the post-swap cleanup.
        (rm as Mock).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('rm failed'));
        const notifyRefresh = vi.fn().mockResolvedValue(undefined);
        const { service } = createService({ connector: { notifyRefresh } });

        await service.enqueueMerge(42);
        await settle();

        expect(unlink).toHaveBeenCalled();
        expect(notifyRefresh).toHaveBeenCalledWith('merge', [expect.objectContaining({ bookId: 42 })]);
      });

      it("commitMerge's staging cleanup runs strictly AFTER the refresh enqueue, so a cleanup failure cannot suppress the now-required rescan", async () => {
        setupHappyPath();
        const notifyRefresh = vi.fn().mockResolvedValue(undefined);
        const { service } = createService({ connector: { notifyRefresh } });

        await service.enqueueMerge(42);
        await settle();

        // Two staging removals: runStaging's pre-mkdir reset, then commitMerge's cleanup.
        const stagingRemovals = (rm as Mock).mock.calls
          .map((call, i) => ({ path: call[0], order: (rm as Mock).mock.invocationCallOrder[i]! }))
          .filter(({ path }) => path === STAGING_DIR)
          .map(({ order }) => order);
        expect(stagingRemovals).toHaveLength(2);

        const refreshOrder = notifyRefresh.mock.invocationCallOrder[0]!;
        expect(refreshOrder).toBeGreaterThan(stagingRemovals[0]!);
        expect(refreshOrder).toBeLessThan(stagingRemovals[1]!);
      });

      it('enqueues NO refresh when the DB size update fails before the unlink (pre-swap failure)', async () => {
        setupHappyPath();
        const notifyRefresh = vi.fn().mockResolvedValue(undefined);
        const { service, db } = createService({ connector: { notifyRefresh } });
        db.update.mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('DB write failed')) }),
        });

        await service.enqueueMerge(42);
        await settle();

        expect(unlink).not.toHaveBeenCalled();
        expect(notifyRefresh).not.toHaveBeenCalled();
      });

      it('a rejecting notifyRefresh does not fail the merge (fire-and-forget)', async () => {
        setupHappyPath();
        const notifyRefresh = vi.fn().mockRejectedValue(new Error('connector down'));
        const { service, log } = createService({ connector: { notifyRefresh } });

        await service.enqueueMerge(42);
        await settle();

        expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
        expect(log.error).not.toHaveBeenCalled();
      });
    });

    it('db.update receives both size and updatedAt from stat() on the post-rename destination path', async () => {
      setupHappyPath();
      (stat as Mock).mockResolvedValue({ size: 123_456_789 });
      const { service, db } = createService();

      await service.enqueueMerge(42);
      await settle();

      const expectedOutputPath = join(BOOK_PATH, 'The Way of Kings.m4b');
      expect(stat).toHaveBeenCalledWith(expectedOutputPath);

      const setMock = (db.update as Mock).mock.results[0]?.value?.set as Mock;
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
        size: 123_456_789,
        updatedAt: expect.any(Date),
      }));
      // Pin both payload and row predicate; either half alone permits a widened update.
      const whereMock = setMock.mock.results[0]?.value?.where as Mock;
      expect(whereMock).toHaveBeenCalledWith(eq(books.id, 42));
    });

    it('emits merge_complete SSE event with message field on success', async () => {
      setupHappyPath();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_complete', {
        book_id: 42,
        book_title: 'The Way of Kings',
        success: true,
        message: 'Merged 2 files into The Way of Kings.m4b',
      });
    });

    describe('#2068 processing notices reach the operator (AC14)', () => {
      /** Assert the warnings channel; debug-level stderr dedup is hidden at the shipped log level. */
      function withWarnings(warnings: string[]): void {
        setupHappyPath();
        (processAudioFiles as Mock).mockResolvedValue({
          success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'], warnings,
        });
      }

      it.each([
        ['no-usable-evidence', 'No usable source bitrate evidence — requesting the 192 kbps default.', '192'],
        ['an explicit target changed', 'Requested bitrate rounded down from 200 kbps to 192 kbps.', '200'],
        ['hint-overrode-probes', 'Stored source bitrate 251 kbps exceeds every probed part (highest 64 kbps).', '251'],
        ['unusable-target', 'Configured target bitrate "NaN" is not a usable kbps value.', 'NaN'],
        ['a cover-art degradation', 'Cover art could not be reattached — continuing without it.', 'Cover art'],
      ])('logs a %s notice at warn and appends it to the merge-complete message', async (_kind, warning, needle) => {
        withWarnings([warning]);
        const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
        const { service, log } = createService({ eventBroadcaster });

        await service.enqueueMerge(42);
        await settle();

        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ bookId: 42 }), warning);
        const emitCalls = (eventBroadcaster.emit as Mock).mock.calls;
        const complete = emitCalls.find((c: unknown[]) => c[0] === 'merge_complete');
        expect((complete![1] as { message: string }).message).toContain(needle);
      });

      it('still logs the notices when the encode itself failed', async () => {
        (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
        (mkdir as Mock).mockResolvedValue(undefined);
        (cp as Mock).mockResolvedValue(undefined);
        (rm as Mock).mockResolvedValue(undefined);
        (processAudioFiles as Mock).mockResolvedValue({
          success: false,
          error: 'ffmpeg exited with code 1',
          warnings: ['Requested bitrate rounded down from 200 kbps to 192 kbps.'],
        });

        const { service, log } = createService();
        await service.enqueueMerge(42);
        await settle();

        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 42 }),
          'Requested bitrate rounded down from 200 kbps to 192 kbps.',
        );
      });
    });

    it('records merged event via eventHistory on success', async () => {
      setupHappyPath();
      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });

      await service.enqueueMerge(42);
      await settle();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 42,
        eventType: 'merged',
        source: 'manual',
      }));
    });

    it('clears in-progress lock after success', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      setupHappyPath();
      await expect(service.enqueueMerge(42)).resolves.toBeDefined();
      await settle();
    });
  });

  describe('enqueueMerge — processAudioFiles failure (pre-verification)', () => {
    it('logs error when processAudioFiles returns { success: false }', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service, log } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: expect.any(String) }) }),
        expect.stringContaining('Merge failed'),
        expect.anything(),
      );
    });

    it('cleans staging dir when processAudioFiles fails', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.enqueueMerge(42);
      await settle();

      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
    });

    it('leaves book.path unchanged when processAudioFiles fails', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.enqueueMerge(42);
      await settle();

      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    // Processor refusal must use the same operator-facing error classification as ffmpeg failure (#2062).
    it('reports a sub-minimum refusal as an ordinary merge_failed with reason error', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({
        success: false,
        error: new InsufficientAudioFilesError(1).message,
      });
      (rm as Mock).mockResolvedValue(undefined);

      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service } = createService({ eventBroadcaster: inject<EventBroadcasterService>(broadcaster) });

      await service.enqueueMerge(42);
      await settle();

      const failed = emitted.filter(e => e.event === 'merge_failed');
      expect(failed).toHaveLength(1);
      const payload = failed[0]!.payload as { reason: string; error: string };
      expect(payload.reason).toBe('error');
      expect(payload.error).toBe('Audio processing failed: Merge requires at least 2 audio files, found 1');
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('clears in-progress lock after failure', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.enqueueMerge(42);
      await settle();

      await expect(service.enqueueMerge(42)).resolves.toBeDefined();
      await settle();
    });
  });

  describe('enqueueMerge — staged verification failure', () => {
    function setupScanFailure() {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [] });
      (scanAudioDirectory as Mock).mockResolvedValue(null);
      (rm as Mock).mockResolvedValue(undefined);
    }

    it('logs error when scanAudioDirectory returns null on staging dir', async () => {
      setupScanFailure();
      const { service, log } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: expect.any(String) }) }),
        expect.stringContaining('Merge failed'),
        expect.anything(),
      );
    });

    it('cleans staging dir when scan fails', async () => {
      setupScanFailure();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
    });

    it('leaves book.path unchanged when scan fails', async () => {
      setupScanFailure();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    });

    it('does not call enrichBookFromAudioWithinAdmissionLock when scan fails', async () => {
      setupScanFailure();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(enrichBookFromAudioWithinAdmissionLock).not.toHaveBeenCalled();
    });
  });

  describe('enqueueMerge — post-commit enrichment failure', () => {
    it('surfaces enrichmentWarning via merge_complete event when enrichBookFromAudioWithinAdmissionLock returns { enriched: false }', async () => {
      setupHappyPath();
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: false });
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service, log } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(log.warn).toHaveBeenCalled();

      const completeCall = (eventBroadcaster.emit as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'merge_complete',
      );
      expect(completeCall).toBeDefined();
      expect(completeCall![1]).toMatchObject({
        enrichmentWarning: 'Merge succeeded but metadata update failed — audio fields may be stale',
      });
    });

    it('M4B remains in book.path after enrichment failure (no rollback)', async () => {
      setupHappyPath();
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: false });
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(rename).toHaveBeenCalledWith(
        join(STAGING_DIR, 'The Way of Kings.m4b'),
        join(BOOK_PATH, 'The Way of Kings.m4b'),
      );
    });
  });

  describe('enqueueMerge — guard conditions', () => {
    it('throws MergeError NOT_FOUND when book does not exist', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(null);

      await expect(service.enqueueMerge(99)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws MergeError NO_PATH when book has no path', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue({ ...mockBook, path: null });

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_PATH' });
    });

    it('throws MergeError NO_STATUS when book is not in imported status', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue({ ...mockBook, status: 'wanted' });

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_STATUS' });
    });

    it('throws MergeError NO_TOP_LEVEL_FILES when fewer than 2 top-level audio files exist', async () => {
      (readdir as Mock).mockResolvedValue(['Chapter 01.m4b']);
      const { service } = createService();

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    it('throws MergeError NO_TOP_LEVEL_FILES when only non-audio files are present', async () => {
      (readdir as Mock).mockResolvedValue(['cover.jpg', 'metadata.nfo']);
      const { service } = createService();

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    // One visible + one born-hidden temp must remain ineligible (#1852).
    it('#1852 F5: one visible + one hidden top-level file rejects NO_TOP_LEVEL_FILES at pre-enqueue', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '.02.tmp.mp3']);
      const { service } = createService();

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    it('#1852 F5 positive twin: two visible files plus a hidden temp is eligible (started), temp never staged', async () => {
      setupHappyPath();
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.m4b'];
        return ['01.mp3', '02.mp3', '.03.tmp.mp3'];
      });
      const { service } = createService();

      const ack = await service.enqueueMerge(42);
      await settle();

      expect(ack).toEqual({ status: 'started', bookId: 42 });
      expect(cp).not.toHaveBeenCalledWith(expect.stringContaining('.03.tmp.mp3'), expect.anything());
    });

    it('throws MergeError FFMPEG_NOT_CONFIGURED when ffmpeg is not detected', async () => {
      ffmpegState.resolves = false;
      const noFfmpegService = new MergeService(
        inject<Db>(createMockDb()),
        inject<BookService>({ getById: vi.fn().mockResolvedValue(mockBook) } as unknown as BookService),
        createMockSettingsService({ processing: { ffmpegPath: '' } as never }),
        inject<FastifyBaseLogger>(createMockLogger()),
      );

      await expect(noFfmpegService.enqueueMerge(42)).rejects.toMatchObject({ code: 'FFMPEG_NOT_CONFIGURED' });
      ffmpegState.resolves = true;
    });

    it('throws MergeError ALREADY_IN_PROGRESS when same book is already being merged', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockReturnValue(new Promise(() => {})); // never resolves
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.enqueueMerge(42);

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });
    });
  });

  describe('concurrency lock', () => {
    it('sets in-progress flag before processing begins', async () => {
      let lockChecked = false;
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => {
        lockChecked = true;
        return { success: false, error: 'test' };
      });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.enqueueMerge(42);
      await settle();

      expect(lockChecked).toBe(true);
    });

    it('clears lock via finally even when an exception is thrown mid-flow', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockImplementation(() => { throw new Error('disk full'); });
      (rm as Mock).mockResolvedValue(undefined);

      const { service } = createService();
      await service.enqueueMerge(42);
      await settle();

      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'test' });
      (rm as Mock).mockResolvedValue(undefined);

      await expect(service.enqueueMerge(42)).resolves.toBeDefined();
      await settle();
    });

    it('allows a second merge request after the first completes', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      vi.clearAllMocks();
      setupHappyPath();
      await expect(service.enqueueMerge(42)).resolves.toBeDefined();
      await settle();
    });
  });
});

describe('#257 merge observability — merge service', () => {
  // resetAllMocks, not clearAllMocks: this describe queues `*Once` implementations, which clearAllMocks leaves undrained.
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('merge_started event', () => {
    it('recorded immediately after pre-flight checks pass (before ffmpeg runs)', async () => {
      let startedRecorded = false;
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async () => {
        startedRecorded = true;
        return { success: false, error: 'test abort' };
      });
      (rm as Mock).mockResolvedValue(undefined);

      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });
      await service.enqueueMerge(42);
      await settle();

      expect(startedRecorded).toBe(true);
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

      await service.enqueueMerge(42);
      await settle();

      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_started', {
        book_id: 42,
        book_title: 'The Way of Kings',
      });
    });

    it('NOT recorded when pre-flight checks fail (NOT_FOUND)', async () => {
      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service, bookService } = createService({ eventHistory });
      (bookService.getById as Mock).mockResolvedValue(null);

      await service.enqueueMerge(99).catch(() => undefined);

      expect(eventHistory.create).not.toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'merge_started',
      }));
    });
  });

  describe('merge_failed event', () => {
    it('recorded when processAudioFiles fails, with error in reason JSON', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const eventHistory = { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService;
      const { service } = createService({ eventHistory });
      await service.enqueueMerge(42);
      await settle();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 42,
        eventType: 'merge_failed',
        source: 'manual',
        reason: { error: 'Audio processing failed: ffmpeg error' },
      }));
    });

    it('SSE event emitted with { book_id, book_title, error } payload', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      (rm as Mock).mockResolvedValue(undefined);

      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });
      await service.enqueueMerge(42);
      await settle();

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

      await service.enqueueMerge(99).catch(() => undefined);

      expect(eventHistory.create).not.toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'merge_failed',
      }));
      expect(eventBroadcaster.emit).not.toHaveBeenCalledWith('merge_failed', expect.anything());
    });
  });

  describe('merge phase progress (via merge_state — #2142)', () => {
    it('the snapshot walks the phases (staging → processing → verifying → committing) with no incremental twin', async () => {
      setupHappyPath();
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      const stateCalls = (eventBroadcaster.emit as Mock).mock.calls.filter(
        (c: unknown[]) => c[0] === 'merge_state',
      );
      const phases = stateCalls.map((c: unknown[]) => (c[1] as { active: Array<{ phase: string }> }).active[0]?.phase);
      expect(phases).toContain('staging');
      expect(phases).toContain('processing');
      expect(phases).toContain('verifying');
      expect(phases).toContain('committing');
      const eventNames = (eventBroadcaster.emit as Mock).mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).not.toContain('merge_progress');
    });
  });

  describe('event emission resilience', () => {
    it('event emission failure (broadcaster throws) does not fail the merge operation', async () => {
      setupHappyPath();
      const eventBroadcaster = {
        emit: vi.fn().mockImplementation(() => { throw new Error('SSE broken'); }),
      } as unknown as EventBroadcasterService;
      const { service, log } = createService({ eventBroadcaster });

      const ack = await service.enqueueMerge(42);
      expect(ack.bookId).toBe(42);
      await settle();

      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ bookId: 42 }), expect.any(String));
    });

    it('a rejected merge_started insert aborts the merge before staging (#2099 AC1)', async () => {
      setupHappyPath();
      const eventHistory = {
        create: vi.fn().mockImplementation((input: { eventType: string }) =>
          input.eventType === 'merge_started' ? Promise.reject(new Error('DB write failed')) : Promise.resolve(undefined)),
      } as unknown as EventHistoryService;
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventHistory, eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(mkdir).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());
      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42 }));
    });

    it('a rejected terminal (merged) history write still does not fail the merge operation', async () => {
      setupHappyPath();
      const eventHistory = {
        create: vi.fn().mockImplementation((input: { eventType: string }) =>
          input.eventType === 'merge_started' ? Promise.resolve(undefined) : Promise.reject(new Error('DB write failed'))),
      } as unknown as EventHistoryService;
      const { service, log } = createService({ eventHistory });

      const ack = await service.enqueueMerge(42);
      expect(ack.bookId).toBe(42);
      await settle();

      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ bookId: 42 }), expect.any(String));
    });
  });

  describe('concurrent merge guard with events', () => {
    it('first accepted merge records merge_started; second ALREADY_IN_PROGRESS records nothing', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockReturnValue(new Promise(() => {})); // never resolves
      (rm as Mock).mockResolvedValue(undefined);

      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);

      // Let the fire-and-forget start event settle.
      await new Promise((r) => process.nextTick(r));

      const emitsBefore = (eventBroadcaster.emit as Mock).mock.calls.length;

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });

      expect((eventBroadcaster.emit as Mock).mock.calls.length).toBe(emitsBefore);

      const startedEmits = (eventBroadcaster.emit as Mock).mock.calls.filter(
        (c: unknown[]) => c[0] === 'merge_started',
      );
      expect(startedEmits).toHaveLength(1);
    });
  });

  describe('stderr deduplication', () => {
    function setupStderrTest(onStderrSetup: (callbacks: { onStderr?: (line: string) => void }) => void) {
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        return ['01.mp3', '02.mp3'];
      });
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, callbacks: { onStderr?: (line: string) => void }) => {
        onStderrSetup(callbacks);
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
    }

    it('3 identical lines logged once with × 3 suffix', async () => {
      setupStderrTest((callbacks) => {
        callbacks?.onStderr?.('Too many packets buffered');
        callbacks?.onStderr?.('Too many packets buffered');
        callbacks?.onStderr?.('Too many packets buffered');
      });

      const { service, log } = createService();
      await service.enqueueMerge(42);
      await settle();

      const debugCalls = (log.debug as Mock).mock.calls;
      const stderrCalls = debugCalls.filter(
        (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'stderr' in (c[0] as Record<string, unknown>),
      );
      expect(stderrCalls).toHaveLength(1);
      expect(stderrCalls[0]![0]).toEqual({ stderr: 'Too many packets buffered', count: 3 });
      expect(stderrCalls[0]![1]).toContain('× 3');
    });

    it('interleaved different lines each logged separately', async () => {
      setupStderrTest((callbacks) => {
        callbacks?.onStderr?.('line A');
        callbacks?.onStderr?.('line B');
        callbacks?.onStderr?.('line A');
      });

      const { service, log } = createService();
      await service.enqueueMerge(42);
      await settle();

      const debugCalls = (log.debug as Mock).mock.calls;
      const stderrCalls = debugCalls.filter(
        (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'stderr' in (c[0] as Record<string, unknown>),
      );
      expect(stderrCalls).toHaveLength(3);
      expect(stderrCalls[0]![0]).toEqual({ stderr: 'line A' });
      expect(stderrCalls[1]![0]).toEqual({ stderr: 'line B' });
      expect(stderrCalls[2]![0]).toEqual({ stderr: 'line A' });
    });

    it('single occurrence logged without count suffix', async () => {
      setupStderrTest((callbacks) => {
        callbacks?.onStderr?.('single line');
      });

      const { service, log } = createService();
      await service.enqueueMerge(42);
      await settle();

      const debugCalls = (log.debug as Mock).mock.calls;
      const stderrCalls = debugCalls.filter(
        (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && 'stderr' in (c[0] as Record<string, unknown>),
      );
      expect(stderrCalls).toHaveLength(1);
      expect(stderrCalls[0]![0]).toEqual({ stderr: 'single line' });
      expect(stderrCalls[0]![1]).toBe('ffmpeg stderr');
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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
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
      // Queue membership appears only in merge_state; the last frame must preserve FIFO title (#2142).
      const stateFrames = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls
        .filter((c: unknown[]) => c[0] === 'merge_state')
        .map((c: unknown[]) => c[1] as { queued: Array<{ book_id: number; book_title: string }> });
      expect(stateFrames.at(-1)!.queued).toEqual([{ book_id: 43, book_title: 'Book B' }]);
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

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      }).mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

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

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      await expect(service.enqueueMerge(43)).rejects.toThrow('Merge already queued for this book');
      resolve();
    });

    it('duplicate merge request for same bookId while in-progress is rejected with ALREADY_IN_PROGRESS', async () => {
      setupFsMocksForMerge();
      const { service, bookService } = createServiceWithBroadcaster();
      setupMergeForBook(bookService, 42, 'Book A');
      const { resolve } = createBlockingMerge();

      await service.enqueueMerge(42);

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

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);
      await service.enqueueMerge(44);

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const startedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_started');
      const startedBookIds = startedEvents.map((c: unknown[]) => (c[1] as { book_id: number }).book_id);
      expect(startedBookIds).toEqual([42, 43, 44]);
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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      }).mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      bookService.getById.mockImplementation(async (id: number) => {
        if (id === 42) return book42;
        return null;
      });

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const failedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_failed');
      expect(failedEvents.some((c: unknown[]) => (c[1] as { book_id: number }).book_id === 43)).toBe(true);
    });

    // Dequeue validation is independent: one visible + one hidden temp must now fail (#1852).
    it('#1852 F6: a queued book that becomes one-visible-plus-one-hidden fails dequeue-time revalidation', async () => {
      const { service, bookService, eventBroadcaster } = createServiceWithBroadcaster();
      const book42 = { ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }), authors: [mockAuthor], narrators: [] };
      const book43 = { ...createMockDbBook({ id: 43, title: 'Book B', path: '/lib/B', status: 'imported' }), authors: [mockAuthor], narrators: [] };
      bookService.getById.mockImplementation(async (id: number) => (id === 42 ? book42 : id === 43 ? book43 : null));

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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      (processAudioFiles as Mock).mockImplementationOnce(async () => { await firstPromise; return { success: true, outputFiles: ['/staging/out.m4b'] }; })
        .mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        if (dir === '/lib/B') return ['02.mp3', '.03.tmp.mp3'];
        return ['01.mp3', '02.mp3'];
      });

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const startedFor = (id: number) => emitCalls.some((c: unknown[]) => c[0] === 'merge_started' && (c[1] as { book_id: number }).book_id === id);
      const failedFor = (id: number) => emitCalls.some((c: unknown[]) => c[0] === 'merge_failed' && (c[1] as { book_id: number }).book_id === id);
      expect(failedFor(43)).toBe(true);
      expect(startedFor(43)).toBe(false);
    });
  });

  describe('#368 merge queue — SSE events', () => {
    it('queued merge enters the merge_state snapshot with its enqueue-time title (#2142)', async () => {
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

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      expect(service.getMergeStateSnapshot().queued).toEqual([{ book_id: 43, book_title: 'Book B' }]);
      const eventNames = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).not.toContain('merge_queued');
    });

    it('the snapshot\'s FIFO order carries the decremented positions when the active merge completes (#2142)', async () => {
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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

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

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);
      await service.enqueueMerge(44);

      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      // Queue index is the position; no positional event exists (#2142).
      const stateFrames = emitCalls
        .filter((c: unknown[]) => c[0] === 'merge_state')
        .map((c: unknown[]) => c[1] as { queued: Array<{ book_id: number }> });
      expect(stateFrames.some((f) => f.queued.length === 1 && f.queued[0]!.book_id === 44)).toBe(true);
      expect(emitCalls.map((c: unknown[]) => c[0])).not.toContain('merge_queue_updated');
    });

    it('merge_complete includes enrichmentWarning when enrichment fails', async () => {
      setupHappyPath();
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: false });
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

      (processAudioFiles as Mock)
        .mockRejectedValueOnce(new Error('FFmpeg crashed'))
        .mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      const service = new MergeService(
        inject<Db>(db), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(log), undefined, eventBroadcaster,
      );

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const emitCalls = (eventBroadcaster as unknown as { emit: Mock }).emit.mock.calls;
      const failedEvents = emitCalls.filter((c: unknown[]) => c[0] === 'merge_failed');
      expect(failedEvents.some((c: unknown[]) => (c[1] as { book_id: number }).book_id === 42)).toBe(true);
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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

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

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);

      // Book 43 now holds the slot, so the new request must queue.
      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const result = await service.enqueueMerge(44);
      expect(result.status).toBe('queued');

      resolveSecond();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe('#1302 maxConcurrentProcessing — semaphore sizing + FIFO under resize', () => {
    function gatedProcessing() {
      let active = 0;
      let peak = 0;
      const releasers: Array<() => void> = [];
      (processAudioFiles as Mock).mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releasers.push(() => { active--; resolve(); }));
        return { success: true, outputFiles: ['/staging/out.m4b'] };
      });
      return {
        peak: () => peak,
        active: () => active,
        releaseAll: () => { for (const r of releasers.splice(0)) r(); },
        releaseOne: () => { const r = releasers.shift(); if (r) r(); },
      };
    }

    function setupMultiBook(ids: number[]) {
      const books = ids.map((id) => ({
        ...createMockDbBook({ id, title: `Book ${id}`, path: `/lib/${id}`, status: 'imported' }),
        authors: [mockAuthor], narrators: [],
      }));
      const bookService = { getById: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
      bookService.getById.mockImplementation(async (id: number) => books.find((b) => b.id === id) ?? null);

      (readdir as Mock).mockImplementation(async (dir: string) =>
        dir.endsWith('.merge-tmp') ? ['out.m4b'] : ['01.mp3', '02.mp3'],
      );
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
      (rename as Mock).mockResolvedValue(undefined);
      (unlink as Mock).mockResolvedValue(undefined);
      (rm as Mock).mockResolvedValue(undefined);
      (stat as Mock).mockResolvedValue({ size: 100 });
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

      return { bookService };
    }

    function buildService(bookService: ReturnType<typeof setupMultiBook>['bookService'], settingsService: SettingsService) {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const service = new MergeService(
        inject<Db>(createMockDb()), inject<BookService>(bookService), settingsService,
        inject<FastifyBaseLogger>(createMockLogger()), undefined, inject<EventBroadcasterService>(broadcaster),
      );
      const startedIds = () => emitted.filter((e) => e.event === 'merge_started').map((e) => (e.payload as { book_id: number }).book_id);
      return { service, startedIds };
    }

    it('with maxConcurrentProcessing = 2, two enqueued merges run concurrently (peak concurrency 2)', async () => {
      const { bookService } = setupMultiBook([42, 43]);
      const gate = gatedProcessing();
      const settingsService = createMockSettingsService({ processing: { ...processingOverrides.processing, maxConcurrentProcessing: 2 } });
      const { service } = buildService(bookService, settingsService);

      const r1 = await service.enqueueMerge(42);
      const r2 = await service.enqueueMerge(43);
      await settle();

      expect(r1.status).toBe('started');
      expect(r2.status).toBe('started');
      expect(gate.peak()).toBe(2);

      gate.releaseAll();
      await settle();
    });

    it('with maxConcurrentProcessing = 1, the second merge stays queued until the first releases (strictly serial)', async () => {
      const { bookService } = setupMultiBook([42, 43]);
      const gate = gatedProcessing();
      const settingsService = createMockSettingsService({ processing: { ...processingOverrides.processing, maxConcurrentProcessing: 1 } });
      const { service, startedIds } = buildService(bookService, settingsService);

      const r1 = await service.enqueueMerge(42);
      const r2 = await service.enqueueMerge(43);
      await settle();

      expect(r1.status).toBe('started');
      expect(r2.status).toBe('queued');
      expect(gate.peak()).toBe(1);
      expect(startedIds()).toEqual([42]);

      gate.releaseAll();
      await settle();
      gate.releaseAll();
      await settle();
      expect(startedIds()).toContain(43);
    });

    it('AC4: after a 1→2 capacity raise, enqueuing a newer book promotes the older queued book first (FIFO, no jump-ahead)', async () => {
      const { bookService } = setupMultiBook([42, 43, 44]);
      const gate = gatedProcessing();

      const processing = { ...processingOverrides.processing, maxConcurrentProcessing: 1 };
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? processing : cat === 'library' ? { path: '/library' } : undefined)),
        getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn(),
      });
      const { service, startedIds } = buildService(bookService, settingsService);

      await service.enqueueMerge(42);
      const bAck = await service.enqueueMerge(43);
      await settle();
      expect(bAck.status).toBe('queued');
      expect(startedIds()).toEqual([42]);

      processing.maxConcurrentProcessing = 2;
      const cAck = await service.enqueueMerge(44);
      await settle();

      expect(cAck.status).toBe('queued');
      expect(startedIds()).toContain(43);
      expect(startedIds()).not.toContain(44);

      gate.releaseAll();
      await settle();
      gate.releaseAll();
      await settle();
    });

    it('defensive clamp: a runtime maxConcurrentProcessing of 0 resolves to an effective size of 1 (no deadlock)', async () => {
      const { bookService } = setupMultiBook([42, 43]);
      const gate = gatedProcessing();
      const settingsService = createMockSettingsService({ processing: { ...processingOverrides.processing, maxConcurrentProcessing: 0 } });
      const { service, startedIds } = buildService(bookService, settingsService);

      const r1 = await service.enqueueMerge(42);
      const r2 = await service.enqueueMerge(43);
      await settle();

      expect(r1.status).toBe('started');
      expect(r2.status).toBe('queued');
      expect(gate.peak()).toBe(1);
      expect(startedIds()).toEqual([42]);

      gate.releaseAll();
      await settle();
      gate.releaseAll();
      await settle();
    });

    it('#1368 shrink takes effect mid-drain: a queued job waits for ALL slots to free, not just one', async () => {
      const { bookService } = setupMultiBook([42, 43, 44]);
      const gate = gatedProcessing();

      const processing = { ...processingOverrides.processing, maxConcurrentProcessing: 2 };
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? processing : cat === 'library' ? { path: '/library' } : undefined)),
        getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn(),
      });
      const { service, startedIds } = buildService(bookService, settingsService);

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);
      await settle();
      expect(startedIds()).toEqual([42, 43]);
      expect(gate.peak()).toBe(2);

      processing.maxConcurrentProcessing = 1;
      const cAck = await service.enqueueMerge(44);
      await settle();
      expect(cAck.status).toBe('queued');

      // One release still leaves active === max; the old slot-pass incorrectly started C here.
      gate.releaseOne();
      await settle();
      expect(startedIds()).toEqual([42, 43]);

      gate.releaseOne();
      await settle();
      expect(startedIds()).toEqual([42, 43, 44]);

      gate.releaseAll();
      await settle();
    });

    it('#1368 no settings-read wedge: a rejecting get(\'processing\') leaves inProgress clean (retry not 409)', async () => {
      const { bookService } = setupMultiBook([42]);
      gatedProcessing();
      const get = vi.fn()
        .mockRejectedValueOnce(new Error('settings cache DB error'))
        .mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? { ...processingOverrides.processing } : cat === 'library' ? { path: '/library' } : undefined));
      const settingsService = inject<SettingsService>({ get, getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn() });
      const { service } = buildService(bookService, settingsService);

      await expect(service.enqueueMerge(42)).rejects.toThrow('settings cache DB error');

      const ack = await service.enqueueMerge(42);
      expect(ack.status).toBe('started');
    });

    it('#1368 no duplicate settings read: the enqueue validate+size path reads get(\'processing\') once', async () => {
      const { bookService } = setupMultiBook([42, 43]);
      const gate = gatedProcessing();
      const get = vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? { ...processingOverrides.processing } : cat === 'library' ? { path: '/library' } : undefined));
      const settingsService = inject<SettingsService>({ get, getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn() });
      const { service } = buildService(bookService, settingsService);

      await service.enqueueMerge(42);
      await settle();

      // Exclude A's validation and execution reads; only B's enqueue sizing path counts.
      get.mockClear();

      const bAck = await service.enqueueMerge(43);
      expect(bAck.status).toBe('queued');
      const processingReads = get.mock.calls.filter((c: unknown[]) => c[0] === 'processing');
      expect(processingReads).toHaveLength(1);

      gate.releaseAll();
      await settle();
    });

    it('#1368 honest queued ack: a capacity raise that promotes the new book acks status=started', async () => {
      const { bookService } = setupMultiBook([42, 43, 44]);
      const gate = gatedProcessing();

      const processing = { ...processingOverrides.processing, maxConcurrentProcessing: 1 };
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? processing : cat === 'library' ? { path: '/library' } : undefined)),
        getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn(),
      });
      const { service, startedIds } = buildService(bookService, settingsService);

      await service.enqueueMerge(42);
      await service.enqueueMerge(43);
      await settle();
      expect(startedIds()).toEqual([42]);

      // Raising to 3 lets drainQueue promote B and C; C's ack must reflect post-drain state.
      processing.maxConcurrentProcessing = 3;
      const cAck = await service.enqueueMerge(44);
      await settle();

      expect(cAck).toEqual({ status: 'started', bookId: 44 });
      const ids = startedIds();
      expect(ids.indexOf(43)).toBeLessThan(ids.indexOf(44));

      gate.releaseAll();
      await settle();
    });
  });

  describe('#1368 clampConcurrency', () => {
    it('coerces NaN to 1 (Math.max(1, NaN) would be NaN)', () => {
      expect(clampConcurrency(NaN)).toBe(1);
    });

    it('coerces 0, negative, fractional, and undefined to 1', () => {
      expect(clampConcurrency(0)).toBe(1);
      expect(clampConcurrency(-3)).toBe(1);
      expect(clampConcurrency(2.5)).toBe(1);
      expect(clampConcurrency(undefined)).toBe(1);
    });

    it('passes through valid integers >= 1', () => {
      expect(clampConcurrency(1)).toBe(1);
      expect(clampConcurrency(8)).toBe(8);
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
      (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
    }

    describe('cancel from queue', () => {
      it('returns cancelled for a queued bookId', async () => {
        setupFsMocksForCancel();
        const { service, emitted } = createServiceWithBroadcasterForCancel();
        const blocking = createBlockingMergeForCancel();

        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        // Push directly to the queue to isolate cancellation.
        (service as unknown as { queue: number[] }).queue.push(43);

        const result = await service.cancelMerge(43);
        expect(result.status).toBe('cancelled');
        expect((service as unknown as { queue: number[] }).queue).not.toContain(43);

        // Book-scoped: book 42's blocking merge shares `emitted`, so an unscoped count would flake.
        const failedEvents = emitted.filter(e => e.event === 'merge_failed' && (e.payload as { book_id: number }).book_id === 43);
        expect(failedEvents).toHaveLength(1);
        expect((failedEvents[0]!.payload as { reason: string }).reason).toBe('cancelled');

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

        // Block processing so cancellation can abort it.
        (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, _cb: unknown, signal?: AbortSignal) => {
          await new Promise<void>((resolve) => {
            if (signal) {
              signal.addEventListener('abort', () => resolve(), { once: true });
            }
          });
          if (signal?.aborted) {
            return { success: false, error: 'Processing aborted' };
          }
          return { success: true, outputFiles: ['/staging/out.m4b'] };
        });

        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        const result = await service.cancelMerge(42);
        expect(result.status).toBe('cancelled');

        await new Promise((r) => setTimeout(r, 100));

        const failedEvents = emitted.filter(e => e.event === 'merge_failed' && (e.payload as { book_id: number }).book_id === 42);
        expect(failedEvents).toHaveLength(1);
        const payload = failedEvents[0]!.payload as { reason: string; error: string };
        expect(payload.reason).toBe('cancelled');
      });

      it('classifies a cover-phase abort as cancelled, not as a cover-art failure', async () => {
        setupFsMocksForCancel();
        const { service, emitted } = createServiceWithBroadcasterForCancel();

        (processAudioFiles as Mock).mockImplementation(async (
          _dir: string, _config: unknown, _ctx: unknown, _cb: unknown, signal?: AbortSignal,
        ) => {
          await new Promise<void>((resolve) => {
            if (signal) signal.addEventListener('abort', () => resolve(), { once: true });
          });
          // An aborted cover phase yields this error without a cover warning (#2080).
          return { success: false, error: 'ffmpeg exited with code null' };
        });

        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        const result = await service.cancelMerge(42);
        expect(result.status).toBe('cancelled');
        await new Promise((r) => setTimeout(r, 100));

        const failedEvents = emitted.filter(e => e.event === 'merge_failed' && (e.payload as { book_id: number }).book_id === 42);
        expect(failedEvents).toHaveLength(1);
        const payload = failedEvents[0]!.payload as { reason: string; error: string };
        expect(payload.reason).toBe('cancelled');
        expect(payload.error).not.toContain('Cover art');
      });
    });

    describe('cancel rejected (committing phase)', () => {
      it('returns committing status when phase is committing', async () => {
        const { service } = createServiceWithBroadcasterForCancel();
        // White-box the otherwise timing-sensitive committing phase.
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
        await service.enqueueMerge(42);
        await settle();

        const result = await service.cancelMerge(42);
        expect(result.status).toBe('not-found');
      });
    });

    /**
     * #2462. A merge broadcast active but still waiting on the admission lock owns no controller,
     * so cancellation is recorded as a flag the waking merge consumes. The lock is real here — the
     * only way to reproduce the wait is to hold the book's admission chain from the test.
     */
    describe('cancel while waiting for the admission lock (#2462)', () => {
      function internals(service: MergeService) {
        return service as unknown as {
          inProgress: Set<number>;
          origins: Map<number, string>;
          abortControllers: Map<number, AbortController>;
          currentPhase: Map<number, string>;
          cancelRequested: Set<number>;
        };
      }

      /** Attribute a filesystem/processing call to one book; separators differ per platform. */
      function callsTouching(mock: Mock, needle: string) {
        return mock.mock.calls.filter((call) => String(call[0]).split('\\').join('/').includes(needle));
      }

      it('settles the cancel at cancel time and runs nothing when the lock frees', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42);
        await settle();
        expect(h.service.getMergeStateSnapshot().active).toEqual([
          { book_id: 42, book_title: 'The Way of Kings', phase: 'starting' },
        ]);

        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });

        // Observable BEFORE the lock frees: the operator sees cancelled at cancel time.
        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.framesOf('merge_failed', 42)[0]!.payload).toMatchObject({
          book_title: 'The Way of Kings', error: 'Cancelled by user', reason: 'cancelled',
        });
        expect(h.historyOf(42, 'merge_failed')).toHaveLength(1);
        expect(h.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });

        parked.resolve();
        await holder;
        await settle();

        expect(h.framesOf('merge_started', 42)).toHaveLength(0);
        expect(h.historyOf(42, 'merge_started')).toHaveLength(0);
        expect(recoverInterruptedCommit).not.toHaveBeenCalled();
        expect(mkdir).not.toHaveBeenCalled();
        expect(cp).not.toHaveBeenCalled();
        expect(processAudioFiles).not.toHaveBeenCalled();
        expect(scanAudioDirectory).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        expect(unlink).not.toHaveBeenCalled();
        expect(h.db.update).not.toHaveBeenCalled();

        // Still exactly one terminal across cancel + wake, and never a completion.
        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.historyOf(42, 'merge_failed')).toHaveLength(1);
        expect(h.frames.filter((f) => f.event === 'merge_complete')).toHaveLength(0);
      });

      it('answers the same on the queued promotion path', async () => {
        const { release } = setupBlockingMerge();
        const h = createMergeHarness({ books: [
          { id: 42, title: 'Dogs of War', path: '/lib/AAA' },
          { id: 43, title: 'The Shining', path: '/lib/BBB' },
        ] });
        const parked = deferred();
        const holder = withBookAdmissionLock(43, () => parked.promise);

        await h.service.enqueueMerge(42);
        expect(await h.service.enqueueMerge(43)).toMatchObject({ status: 'queued' });

        // 43 reaches the wait through startQueuedMerge → executeWithRevalidation → executeMerge.
        release();
        await settle();
        expect(h.service.getMergeStateSnapshot().active).toEqual([
          { book_id: 43, book_title: 'The Shining', phase: 'starting' },
        ]);

        expect(await h.service.cancelMerge(43)).toEqual({ status: 'cancelled' });
        expect(h.framesOf('merge_failed', 43)).toHaveLength(1);
        expect(h.framesOf('merge_failed', 43)[0]!.payload).toMatchObject({ error: 'Cancelled by user', reason: 'cancelled' });
        expect(h.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });

        parked.resolve();
        await holder;
        await settle();

        expect(h.framesOf('merge_started', 43)).toHaveLength(0);
        expect(callsTouching(recoverInterruptedCommit as Mock, 'BBB')).toHaveLength(0);
        expect(callsTouching(mkdir as Mock, 'BBB')).toHaveLength(0);
        expect(callsTouching(cp as Mock, 'BBB')).toHaveLength(0);
        expect(callsTouching(processAudioFiles as Mock, 'BBB')).toHaveLength(0);
        expect(h.framesOf('merge_failed', 43)).toHaveLength(1);
        expect(h.historyOf(43, 'merge_failed')).toHaveLength(1);
        expect(h.framesOf('merge_complete', 43)).toHaveLength(0);
      });

      // The queued chain has its own `.finally()`, so the slot-path cleanup case below cannot
      // speak for it: a regression that clears only on the slot path leaves this book unmergeable.
      it('clears the queued-path flag on settlement, so the same book merges again', async () => {
        const { release } = setupBlockingMerge();
        const h = createMergeHarness({ books: [
          { id: 42, title: 'Dogs of War', path: '/lib/AAA' },
          { id: 43, title: 'The Shining', path: '/lib/BBB' },
        ] });
        const parked = deferred();
        const holder = withBookAdmissionLock(43, () => parked.promise);

        await h.service.enqueueMerge(42);
        expect(await h.service.enqueueMerge(43)).toMatchObject({ status: 'queued' });

        release();
        await settle();
        expect(await h.service.cancelMerge(43)).toEqual({ status: 'cancelled' });

        parked.resolve();
        await holder;
        await settle();

        const state = internals(h.service);
        expect(state.cancelRequested.has(43)).toBe(false);
        expect(state.inProgress.has(43)).toBe(false);
        expect(state.origins.has(43)).toBe(false);
        expect(state.abortControllers.has(43)).toBe(false);
        expect(state.currentPhase.has(43)).toBe(false);
        expect(hasPendingBookAdmission(43)).toBe(false);

        // A surviving flag would accept this enqueue and then silently run nothing.
        expect(await h.service.enqueueMerge(43)).toEqual({ status: 'started', bookId: 43 });
        await settle();

        expect(h.framesOf('merge_started', 43)).toHaveLength(1);
        expect(h.framesOf('merge_complete', 43)).toHaveLength(1);
        expect(h.historyOf(43, 'merged')).toHaveLength(1);
        expect(h.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
      });

      it('emits one terminal only, even when dequeue revalidation then fails on the cancelled book', async () => {
        const { release } = setupBlockingMerge();
        const h = createMergeHarness({ books: [
          { id: 42, title: 'Dogs of War', path: '/lib/AAA' },
          { id: 43, title: 'The Shining', path: '/lib/BBB' },
        ] });

        // Park 43's dequeue-time read so the cancel lands inside revalidation, then vanish the row
        // so that revalidation raises its own MergeError after the cancel has already settled.
        const parkedRead = deferred();
        let reads43 = 0;
        h.bookService.getById.mockImplementation(async (id: number) => {
          if (id !== 43) return h.rowFor(id);
          reads43 += 1;
          if (reads43 === 1) return h.rowFor(43);
          await parkedRead.promise;
          return null;
        });

        await h.service.enqueueMerge(42);
        await h.service.enqueueMerge(43);

        release();
        await settle();
        expect(reads43).toBe(2);

        expect(await h.service.cancelMerge(43)).toEqual({ status: 'cancelled' });
        parkedRead.resolve();
        await settle();

        expect(h.framesOf('merge_failed', 43)).toHaveLength(1);
        expect(h.framesOf('merge_failed', 43)[0]!.payload).toMatchObject({ error: 'Cancelled by user', reason: 'cancelled' });
        expect(h.historyOf(43, 'merge_failed')).toHaveLength(1);
      });

      it('is idempotent — a second cancel during the same wait adds no event', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42);
        await settle();

        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });
        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });

        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.historyOf(42, 'merge_failed')).toHaveLength(1);

        parked.resolve();
        await holder;
        await settle();
        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.historyOf(42, 'merge_failed')).toHaveLength(1);
      });

      it('preserves the merge origin on the cancel-time history row', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42, 'auto');
        await settle();

        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });
        expect(h.historyOf(42, 'merge_failed')[0]).toMatchObject({
          source: 'auto', reason: { error: 'Cancelled by user' },
        });

        parked.resolve();
        await holder;
        await settle();
      });

      it('answers not-found while enqueue is still in pre-flight, and leaves no flag when pre-flight rejects', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });

        // Park pre-flight's own book read: inProgress is already set, but nothing is broadcast yet.
        const parkedPreflight = deferred();
        h.bookService.getById.mockImplementationOnce(async () => { await parkedPreflight.promise; return null; });

        const enqueued = h.service.enqueueMerge(42).catch((error: unknown) => error);
        await settle();

        // Deliberate: the operator has been shown no merge, so there is nothing to cancel.
        expect(await h.service.cancelMerge(42)).toEqual({ status: 'not-found' });
        expect(h.framesOf('merge_failed', 42)).toHaveLength(0);
        expect(internals(h.service).cancelRequested.has(42)).toBe(false);

        parkedPreflight.resolve();
        expect(await enqueued).toMatchObject({ message: 'Book not found' });
        expect(internals(h.service).cancelRequested.has(42)).toBe(false);

        // A residual flag would silence this merge instead of running it.
        await h.service.enqueueMerge(42);
        await settle();
        expect(h.framesOf('merge_complete', 42)).toHaveLength(1);
      });

      it('takes the cancelled exit even when the blocking holder rejects', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        // withBookAdmissionLock runs the successor on both settle paths.
        const holder = withBookAdmissionLock(42, () => parked.promise).catch(() => undefined);

        await h.service.enqueueMerge(42);
        await settle();
        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });

        parked.reject(new Error('the holder blew up'));
        await holder;
        await settle();

        expect(processAudioFiles).not.toHaveBeenCalled();
        expect(mkdir).not.toHaveBeenCalled();
        expect(h.framesOf('merge_started', 42)).toHaveLength(0);
        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
      });

      it('hands a cancel racing the wake to the abort arm, still reporting exactly one cancellation', async () => {
        // The two arms meet without a hole: executeMergeLocked's flag check and its
        // abortControllers.set are one synchronous block, and withBookAdmissionLock invokes the
        // successor synchronously inside the predecessor's reaction, so a cancel racing the wake
        // lands on one side or the other and never on "no controller, not active". The earlier side
        // is the case above; observation shows the holder's own continuation already lands on the
        // later side, so this pins THAT one: registered, therefore aborted — never a 404, never a
        // second terminal, never a completion.
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42);
        await settle();

        const cancelAtWake = holder.then(() => h.service.cancelMerge(42));
        parked.resolve();
        expect(await cancelAtWake).toEqual({ status: 'cancelled' });
        await settle();

        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.framesOf('merge_failed', 42)[0]!.payload).toMatchObject({ error: 'Cancelled by user', reason: 'cancelled' });
        expect(h.historyOf(42, 'merge_failed')).toHaveLength(1);
        expect(h.framesOf('merge_complete', 42)).toHaveLength(0);
        expect(h.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
        expect(internals(h.service).cancelRequested.has(42)).toBe(false);
      });

      it('keeps the semaphore slot until the holder finishes, then drains the queue', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [
          { id: 42, title: 'Dogs of War', path: '/lib/AAA' },
          { id: 43, title: 'The Shining', path: '/lib/BBB' },
        ] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42);
        expect(await h.service.enqueueMerge(43)).toMatchObject({ status: 'queued' });
        await settle();

        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });
        await settle();

        // Accepted consequence: the cancelled merge keeps its slot until the holder finishes.
        expect(h.service.getMergeStateSnapshot()).toEqual({
          active: [], queued: [{ book_id: 43, book_title: 'The Shining' }],
        });
        expect(h.framesOf('merge_started', 43)).toHaveLength(0);
        // Accepted consequence: the same book cannot be re-enqueued inside the residual window.
        await expect(h.service.enqueueMerge(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });

        parked.resolve();
        await holder;
        await settle();

        expect(h.framesOf('merge_started', 43)).toHaveLength(1);
        expect(h.framesOf('merge_complete', 43)).toHaveLength(1);
        // The shared harness scopes by book: 42's cancellation and 43's completion never cross accessors.
        expect(h.framesOf('merge_complete', 42)).toHaveLength(0);
        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.framesOf('merge_failed', 43)).toHaveLength(0);
      });

      it('cancels even when the cancel-time history write rejects', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42);
        await settle();
        h.create.mockRejectedValueOnce(new Error('history table is gone'));

        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });
        expect(h.framesOf('merge_failed', 42)).toHaveLength(1);
        expect(h.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });

        parked.resolve();
        await holder;
        await settle();
      });

      it('leaves no per-book state behind once the cancelled merge settles', async () => {
        setupHappyPath();
        const h = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
        const parked = deferred();
        const holder = withBookAdmissionLock(42, () => parked.promise);

        await h.service.enqueueMerge(42);
        await settle();
        expect(await h.service.cancelMerge(42)).toEqual({ status: 'cancelled' });

        parked.resolve();
        await holder;
        await settle();

        const state = internals(h.service);
        expect(state.inProgress.has(42)).toBe(false);
        expect(state.origins.has(42)).toBe(false);
        expect(state.abortControllers.has(42)).toBe(false);
        expect(state.currentPhase.has(42)).toBe(false);
        expect(state.cancelRequested.has(42)).toBe(false);
        expect(h.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
        expect(hasPendingBookAdmission(42)).toBe(false);
        expect(await h.service.cancelMerge(42)).toEqual({ status: 'not-found' });
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

      await service.enqueueMerge(42);
      await settle();

      const snapshotPhases = emitted
        .filter(e => e.event === 'merge_state')
        .flatMap(e => (e.payload as { active: Array<{ phase: string }> }).active.map((a) => a.phase));
      expect(snapshotPhases).toContain('committing');
      expect(snapshotPhases).not.toContain('finalizing');

      expect(snapshotPhases.at(-1)).toBe('committing');
    });

    it('finalizing phase no longer exists in emitted events', async () => {
      setupHappyPath();
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service } = createService({
        eventBroadcaster: inject<EventBroadcasterService>(broadcaster),
      });

      await service.enqueueMerge(42);
      await settle();

      const phases = emitted
        .filter(e => e.event === 'merge_state')
        .flatMap(e => (e.payload as { active: Array<{ phase: string }> }).active.map((a) => a.phase));
      expect(phases).not.toContain('finalizing');
    });
  });

  describe('typed cancellation signal', () => {
    it('merge_failed event includes reason error on real failures', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
      (mkdir as Mock).mockResolvedValue(undefined);
      (cp as Mock).mockResolvedValue(undefined);
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg crashed' });
      (rm as Mock).mockResolvedValue(undefined);

      const emitted: Array<{ event: string; payload: unknown }> = [];
      const broadcaster = { emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }) };
      const { service } = createService({
        eventBroadcaster: inject<EventBroadcasterService>(broadcaster),
      });

      await service.enqueueMerge(42);
      await settle();

      const failedEvents = emitted.filter(e => e.event === 'merge_failed');
      expect(failedEvents).toHaveLength(1);
      expect((failedEvents[0]!.payload as { reason: string }).reason).toBe('error');
    });
  });
});

describe('#1838 merge origin — event provenance', () => {
  // resetAllMocks, not clearAllMocks: the queued-path case queues a `*Once` implementation.
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('auto immediate-start success records merge_started and merged with source auto', async () => {
    setupHappyPath();
    const { service, historyOf, frames } = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }], broadcaster: 'absent' });

    await service.enqueueMerge(42, 'auto');
    await settle();
    // AC9: this arm has never exercised the emit paths; a silent swap to the recording harness would.
    expect(frames).toEqual([]);

    expect(historyOf(42, 'merge_started')[0]?.source).toBe('auto');
    expect(historyOf(42, 'merged')[0]?.source).toBe('auto');
  });

  it('auto immediate-start failure records merge_failed with source auto', async () => {
    (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
    (mkdir as Mock).mockResolvedValue(undefined);
    (cp as Mock).mockResolvedValue(undefined);
    (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
    (rm as Mock).mockResolvedValue(undefined);
    const { service, historyOf } = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }], broadcaster: 'absent' });

    await service.enqueueMerge(42, 'auto');
    await settle();

    const failed = historyOf(42, 'merge_failed');
    expect(failed[0]?.source).toBe('auto');
  });

  it('auto queued path carries source auto while a concurrent manual book stays manual', async () => {
    setupHappyPath();
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
    (processAudioFiles as Mock)
      .mockImplementationOnce(async () => { await firstPromise; return { success: true, outputFiles: [STAGING_DIR + '/out.m4b'] }; })
      .mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/out.m4b'] });
    const { service, historyOf } = createMergeHarness({
      books: [{ id: 42, title: 'Book A', path: '/lib/A' }, { id: 43, title: 'Book B', path: '/lib/B' }],
      broadcaster: 'absent',
    });

    await service.enqueueMerge(42, 'manual');
    const ack = await service.enqueueMerge(43, 'auto');
    expect(ack.status).toBe('queued');

    resolveFirst();
    await settle();

    expect(historyOf(42, 'merge_started')[0]?.source).toBe('manual');
    expect(historyOf(42, 'merged')[0]?.source).toBe('manual');
    expect(historyOf(43, 'merge_started')[0]?.source).toBe('auto');
    expect(historyOf(43, 'merged')[0]?.source).toBe('auto');
  });

  it('cancel of a queued auto merge emits merge_failed(cancelled) with source auto', async () => {
    setupHappyPath();
    (processAudioFiles as Mock).mockImplementation(async () => new Promise(() => {}));
    const { service, historyOf } = createMergeHarness({
      books: [{ id: 42, title: 'Book A', path: '/lib/A' }, { id: 43, title: 'Book B', path: '/lib/B' }],
      broadcaster: 'absent',
    });

    await service.enqueueMerge(42, 'manual');
    await service.enqueueMerge(43, 'auto');

    const result = await service.cancelMerge(43);
    expect(result.status).toBe('cancelled');

    const failed = historyOf(43, 'merge_failed');
    expect(failed[0]?.source).toBe('auto');
    expect(failed[0]).toMatchObject({ reason: { error: 'Cancelled by user' } });
  });

  it('rejected auto enqueue leaves no stale origin — a later manual merge records source manual (F1)', async () => {
    (readdir as Mock).mockResolvedValue(['01.mp3']);
    const { service, historyOf } = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }], broadcaster: 'absent' });

    await expect(service.enqueueMerge(42, 'auto')).rejects.toThrow(/No top-level audio files/);
    expect(historyOf(42, 'merge_started')).toHaveLength(0);
    expect(historyOf(42, 'merged')).toHaveLength(0);

    setupHappyPath();
    await service.enqueueMerge(42);
    await settle();

    expect(historyOf(42, 'merge_started')[0]?.source).toBe('manual');
    expect(historyOf(42, 'merged')[0]?.source).toBe('manual');
  });

  it('origin is cleared after a merge completes — a subsequent same-book merge uses the new origin', async () => {
    setupHappyPath();
    const { service, historyOf } = createMergeHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }], broadcaster: 'absent' });

    await service.enqueueMerge(42, 'auto');
    await settle();
    await service.enqueueMerge(42, 'manual');
    await settle();

    expect(historyOf(42, 'merged').map((e) => e.source)).toEqual(['auto', 'manual']);
  });
});

// Source-tag forwarding cannot apply canonical DB tags; post-merge tagging must reuse retagBookWithinAdmissionLock (#2078).

const MERGED_OUTPUT = join(BOOK_PATH, 'The Way of Kings.m4b');

function retagResult(over: Partial<RetagResult> = {}): RetagResult {
  return {
    bookId: 42,
    tagged: 1,
    skipped: 0,
    failed: 0,
    warnings: [],
    refreshItem: { bookId: 42, title: 'The Way of Kings', authorName: 'Author', libraryPath: BOOK_PATH },
    ...over,
  };
}

function tagger(result: RetagResult = retagResult()) {
  return { retagBookWithinAdmissionLock: vi.fn().mockResolvedValue(result) };
}

const TAGGING_ON = { enabled: true, mode: 'overwrite' as const, embedCover: true };

describe('#2078 post-merge re-tag', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls retagBookWithinAdmissionLock(bookId) exactly once, with no overrides, when tag embedding is on (AC10)', async () => {
    setupHappyPath();
    const tagging = tagger();
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    // Omitting overrides keeps merge-time tagging on retagBookWithinAdmissionLock's canonical projection.
    expect(tagging.retagBookWithinAdmissionLock).toHaveBeenCalledTimes(1);
    expect(tagging.retagBookWithinAdmissionLock).toHaveBeenCalledWith(42);
    expect(tagging.retagBookWithinAdmissionLock.mock.calls[0]).toHaveLength(1);
  });

  it('does not start the tag write until the merge commit has landed the output (AC10)', async () => {
    setupHappyPath();
    // Gate the staging rename: retagBookWithinAdmissionLock resolves book.path and must see its output and cover.
    let releaseCommit!: () => void;
    const committed = new Promise<void>((res) => { releaseCommit = res; });
    (rename as Mock).mockImplementation(() => committed);

    const tagging = tagger();
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    expect(rename).toHaveBeenCalledWith(join(STAGING_DIR, 'The Way of Kings.m4b'), MERGED_OUTPUT);
    expect(tagging.retagBookWithinAdmissionLock).not.toHaveBeenCalled();

    releaseCommit();
    await settle();

    expect(tagging.retagBookWithinAdmissionLock).toHaveBeenCalledWith(42);
  });

  it('survives a rejecting tagging-settings read — the merge is already committed (AC10)', async () => {
    setupHappyPath();
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const tagging = tagger();
    const { service, settingsService, log } = createService({
      tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster,
    });
    const realGet = (settingsService.get as Mock).getMockImplementation()!;
    (settingsService.get as Mock).mockImplementation((category: string) =>
      category === 'tagging'
        ? Promise.reject(new Error('settings store unavailable'))
        : realGet(category));

    await service.enqueueMerge(42);
    await settle();

    // commitMerge deleted the originals; merge_failed would falsely deny an irreversible merge.
    expect(log.warn).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith(
      'merge_complete', expect.objectContaining({ success: true }),
    );
    expect(vi.mocked(eventBroadcaster.emit).mock.calls.some((c) => c[0] === 'merge_failed')).toBe(false);
    expect(tagging.retagBookWithinAdmissionLock).not.toHaveBeenCalled();
    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
  });

  it('never calls retagBookWithinAdmissionLock when tag embedding is off — Layer 1 alone governs (AC14)', async () => {
    setupHappyPath();
    const tagging = tagger();
    const { service } = createService({
      tagging: { enabled: false, mode: 'overwrite', embedCover: true },
      taggingService: tagging,
    });

    const ack = await service.enqueueMerge(42);
    await settle();

    // retagBookWithinAdmissionLock is also the ungated manual entry point, so merge must enforce enabled here.
    expect(tagging.retagBookWithinAdmissionLock).not.toHaveBeenCalled();
    expect(ack).toEqual({ status: 'started', bookId: 42 });
    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
  });

  it.each([
    ['a plain Error', new Error('ffmpeg blew up')],
    ['a RetagError', new RetagError('PATH_MISSING', 'Book path does not exist on disk')],
  ])('survives a rejected retagBookWithinAdmissionLock (%s) — merge still reports success (AC10)', async (_label, error) => {
    setupHappyPath();
    const tagging = { retagBookWithinAdmissionLock: vi.fn().mockRejectedValue(error) };
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service, log } = createService({ tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(log.warn).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith(
      'merge_complete', expect.objectContaining({ success: true }),
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
  });

  it('survives a returned failed > 0 and surfaces its warnings to the operator (AC10, AC13)', async () => {
    setupHappyPath();
    const tagging = tagger(retagResult({
      tagged: 0, failed: 1, warnings: ['01.m4b: Output file suspiciously small — possible corruption'],
    }));
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service, log } = createService({ tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(log.warn).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith('merge_complete', expect.objectContaining({
      success: true,
      message: expect.stringContaining('Output file suspiciously small'),
    }));
    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
  });

  it('warns and continues when tag embedding is on but no tagger is wired (AC10)', async () => {
    setupHappyPath();
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service, log } = createService({ tagging: TAGGING_ON, taggingService: null, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(log.warn).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith('merge_complete', expect.objectContaining({
      success: true,
      message: 'Merged 2 files into The Way of Kings.m4b',
    }));
    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
  });

  function statsOnOutput(): number {
    return vi.mocked(stat).mock.calls.filter((c) => c[0] === MERGED_OUTPUT).length;
  }

  it('takes the size stat only AFTER the tag rewrite resolves (AC11)', async () => {
    setupHappyPath();
    // tagFile's atomic rewrite invalidates commitMerge's earlier stat.
    const sizes = [500_000_000, 500_004_096];
    (stat as Mock).mockImplementation(async () => ({ size: sizes.shift() ?? 500_004_096 }));

    // Gating retagBookWithinAdmissionLock proves ordering; sequential stat values alone do not.
    let release!: (r: RetagResult) => void;
    const gate = new Promise<RetagResult>((res) => { release = res; });
    const tagging = { retagBookWithinAdmissionLock: vi.fn().mockReturnValue(gate) };
    const { service, db } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    expect(tagging.retagBookWithinAdmissionLock).toHaveBeenCalled();
    expect(statsOnOutput()).toBe(1);

    release(retagResult());
    await settle();

    expect(statsOnOutput()).toBe(2);
    const lastSet = (db.update as Mock).mock.results.at(-1)?.value?.set as Mock;
    expect(lastSet).toHaveBeenCalledWith(expect.objectContaining({
      size: 500_004_096, updatedAt: expect.any(Date),
    }));
  });

  it('awaits the final size write before the merge moves on (AC11)', async () => {
    setupHappyPath();
    (stat as Mock).mockResolvedValue({ size: 500_004_096 });

    // Gate where(), not set(): only the terminus exposes a dropped await.
    let releasePersist!: () => void;
    const persisted = new Promise<void>((res) => { releasePersist = res; });
    const gatedWhere = vi.fn().mockImplementation(() => ({
      // Production awaits this thenable directly; it never calls returning().
      then: (onOk: unknown, onErr: unknown) =>
        persisted.then(() => undefined).then(onOk as never, onErr as never),
    }));

    // Identify the post-tag update by tag state, not brittle call order.
    let tagWriteDone = false;
    const tagging = {
      retagBookWithinAdmissionLock: vi.fn().mockImplementation(async () => { tagWriteDone = true; return retagResult(); }),
    };
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service, db } = createService({ tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster });
    (db.update as Mock).mockImplementation(() =>
      tagWriteDone ? { set: vi.fn().mockReturnValue({ where: gatedWhere }) } : mockDbChain());

    await service.enqueueMerge(42);
    await settle();

    expect(gatedWhere).toHaveBeenCalledTimes(1);
    expect(enrichBookFromAudioWithinAdmissionLock).not.toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit).mock.calls.some((c) => c[0] === 'merge_complete')).toBe(false);

    releasePersist();
    await settle();

    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ success: true }));
  });

  it('scopes the final size write to exactly the merged book row (AC11)', async () => {
    setupHappyPath();
    (stat as Mock).mockResolvedValue({ size: 500_004_096 });

    const capturedWhere: unknown[] = [];
    let tagWriteDone = false;
    const tagging = {
      retagBookWithinAdmissionLock: vi.fn().mockImplementation(async () => { tagWriteDone = true; return retagResult(); }),
    };
    const { service, db } = createService({ tagging: TAGGING_ON, taggingService: tagging });
    (db.update as Mock).mockImplementation(() => {
      if (!tagWriteDone) return mockDbChain();
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((predicate: unknown) => {
            capturedWhere.push(predicate);
            return Promise.resolve(undefined);
          }),
        }),
      };
    });

    await service.enqueueMerge(42);
    await settle();

    // Pin the predicate; payload-only assertions miss widened or misdirected updates.
    expect(capturedWhere).toHaveLength(1);
    expect(capturedWhere[0]).toEqual(eq(books.id, 42));
    expect(capturedWhere[0]).not.toEqual(eq(books.id, 43));
  });

  it('fires the post-tag metadata connector refresh only when a file was actually tagged (AC12)', async () => {
    setupHappyPath();
    const connector = { notifyRefresh: vi.fn().mockResolvedValue(undefined) };
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagger(), connector });

    await service.enqueueMerge(42);
    await settle();

    // Merge refresh covers removed sources; metadata refresh covers the tagged output.
    expect(connector.notifyRefresh).toHaveBeenCalledWith('merge', expect.any(Array));
    expect(connector.notifyRefresh).toHaveBeenCalledWith('metadata', [
      expect.objectContaining({ bookId: 42, libraryPath: BOOK_PATH }),
    ]);
  });

  it('does not fire the metadata refresh when nothing was tagged (AC12)', async () => {
    setupHappyPath();
    const connector = { notifyRefresh: vi.fn().mockResolvedValue(undefined) };
    const { service } = createService({
      tagging: TAGGING_ON, connector,
      taggingService: tagger(retagResult({ tagged: 0, skipped: 1 })),
    });

    await service.enqueueMerge(42);
    await settle();

    expect(connector.notifyRefresh).toHaveBeenCalledWith('merge', expect.any(Array));
    expect(connector.notifyRefresh).not.toHaveBeenCalledWith('metadata', expect.anything());
  });

  it('folds tag-step warnings into the merge_complete message beside the processing ones (AC13)', async () => {
    setupHappyPath();
    (processAudioFiles as Mock).mockResolvedValue({
      success: true,
      outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'],
      warnings: ['Requested bitrate capped from 320 kbps to 256 kbps'],
    });
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service } = createService({
      tagging: TAGGING_ON, eventBroadcaster,
      taggingService: tagger(retagResult({ warnings: ['Cover art embedding enabled but no cover image found in book directory'] })),
    });

    await service.enqueueMerge(42);
    await settle();

    const emitted = vi.mocked(eventBroadcaster.emit).mock.calls.find((c) => c[0] === 'merge_complete')!;
    const message = (emitted[1] as { message: string }).message;
    expect(message).toContain('Requested bitrate capped from 320 kbps to 256 kbps');
    expect(message).toContain('Cover art embedding enabled but no cover image found');
  });

  it('finishes the tag write BEFORE enrichment reads the file back', async () => {
    setupHappyPath();
    // Gating resolution catches an un-awaited retagBookWithinAdmissionLock; call order does not.
    let release!: (r: RetagResult) => void;
    const gate = new Promise<RetagResult>((res) => { release = res; });
    const tagging = { retagBookWithinAdmissionLock: vi.fn().mockReturnValue(gate) };
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    expect(tagging.retagBookWithinAdmissionLock).toHaveBeenCalled();
    expect(enrichBookFromAudioWithinAdmissionLock).not.toHaveBeenCalled();

    release(retagResult());
    await settle();

    expect(enrichBookFromAudioWithinAdmissionLock).toHaveBeenCalled();
  });
});

/**
 * Recovery relies on merge_started, so production cannot touch staging before that row commits.
 * stagingOwned also prevents a failed insert from deleting an older crash orphan. Assertions
 * target STAGING_DIR because admission and ffmpeg resolution legitimately touch fs first (#2099).
 */
describe('#2099 durable merge_started before staging (AC1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not touch the staging path until the merge_started insert settles', async () => {
    setupHappyPath();
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((res) => { releaseInsert = () => res(); });
    const eventHistory = {
      create: vi.fn().mockImplementation((input: { eventType: string }) =>
        input.eventType === 'merge_started' ? insertGate : Promise.resolve(undefined)),
    } as unknown as EventHistoryService;
    const { service } = createService({ eventHistory });

    await service.enqueueMerge(42);
    await settle();

    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'merge_started' }));
    expect(recoverInterruptedCommit).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());
    expect(cp).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('.merge-tmp'));
    expect(rm).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());

    releaseInsert();
    await settle();

    expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });
    expect(processAudioFiles).toHaveBeenCalled();
  });

  it('a rejected insert aborts with merge_failed and leaves a prior crash’s orphan intact', async () => {
    // Seed an older crash orphan; failed admission must not erase recovery evidence.
    (readdir as Mock).mockImplementation(async (dir: string) => {
      if (dir.endsWith('.merge-tmp')) return ['orphan.m4b'];
      return ['01.mp3', '02.mp3'];
    });
    (mkdir as Mock).mockResolvedValue(undefined);
    (cp as Mock).mockResolvedValue(undefined);
    (rm as Mock).mockResolvedValue(undefined);
    (rename as Mock).mockResolvedValue(undefined);

    const eventHistory = {
      create: vi.fn().mockImplementation((input: { eventType: string }) =>
        input.eventType === 'merge_started' ? Promise.reject(new Error('DB write failed')) : Promise.resolve(undefined)),
    } as unknown as EventHistoryService;
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service } = createService({ eventHistory, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(mkdir).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());
    expect(cp).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('.merge-tmp'));
    expect(rename).not.toHaveBeenCalledWith(expect.stringContaining('.merge-tmp'), expect.anything());
    expect(rm).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());
    expect(await readdir(STAGING_DIR)).toEqual(['orphan.m4b']);
    expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42 }));
  });

  it('emits the merge_started SSE synchronously even when the insert then rejects', async () => {
    setupHappyPath();
    const emitted: string[] = [];
    const eventBroadcaster = {
      emit: vi.fn((event: string) => { emitted.push(event); }),
    } as unknown as EventBroadcasterService;
    let insertInvoked = false;
    const eventHistory = {
      create: vi.fn().mockImplementation((input: { eventType: string }) => {
        if (input.eventType !== 'merge_started') return Promise.resolve(undefined);
        // The SSE runs after create() returns but before this promise is awaited.
        insertInvoked = true;
        return Promise.reject(new Error('DB write failed'));
      }),
    } as unknown as EventHistoryService;
    const { service } = createService({ eventHistory, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(insertInvoked).toBe(true);
    // Ignore merge_state snapshots; only discrete event ordering matters (#2129).
    const discrete = emitted.filter((event) => event !== 'merge_state');
    expect(discrete[0]).toBe('merge_started');
    expect(emitted).toContain('merge_failed');
  });

  it('out of domain: with no eventHistory wired the merge stages, commits and cleans as before', async () => {
    setupHappyPath();
    const { service } = createService();

    await service.enqueueMerge(42);
    await settle();

    expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });
    expect(processAudioFiles).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith(join(STAGING_DIR, 'The Way of Kings.m4b'), join(BOOK_PATH, 'The Way of Kings.m4b'));
    expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
  });
});

describe('#2540 shared merge harness — caller-supplied terminal observer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('runs the hook inside the merge_complete emit, handed the constructed service with the book already dropped', async () => {
    setupHappyPath();
    const seen: Array<{ event: string; bookId: number; active: number[]; queued: number[]; sameService: boolean }> = [];
    let snapshotFramesAtHook = -1;
    const h = createMergeHarness({
      books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }],
      onTerminal: (service, frame) => {
        const snapshot = service.getMergeStateSnapshot();
        snapshotFramesAtHook = h.snapshots().length;
        seen.push({
          event: frame.event,
          bookId: frame.payload.book_id as number,
          active: snapshot.active.map((e) => e.book_id),
          queued: snapshot.queued.map((e) => e.book_id),
          sameService: service === h.service,
        });
      },
    });

    await h.service.enqueueMerge(42);
    await settle();

    expect(seen).toEqual([{ event: 'merge_complete', bookId: 42, active: [], queued: [], sameService: true }]);
    // Mid-emit, not after: exactly one cleared snapshot frame is still owed when the hook runs.
    expect(h.snapshots().length - snapshotFramesAtHook).toBe(1);
  });

  it('runs the hook on the merge_failed arm, and on no other frame', async () => {
    setupHappyPath();
    (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
    const seen: Array<{ event: string; bookId: number; active: number[] }> = [];
    const h = createMergeHarness({
      books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }],
      onTerminal: (service, frame) => {
        seen.push({
          event: frame.event,
          bookId: frame.payload.book_id as number,
          active: service.getMergeStateSnapshot().active.map((e) => e.book_id),
        });
      },
    });

    await h.service.enqueueMerge(42);
    await settle();

    expect(seen).toEqual([{ event: 'merge_failed', bookId: 42, active: [] }]);
    // Both non-terminal frame kinds were emitted on this run; neither reached the hook.
    expect(h.events()).toEqual(expect.arrayContaining(['merge_state', 'merge_started']));
  });
});
