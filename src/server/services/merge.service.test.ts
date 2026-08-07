import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { MergeService, clampConcurrency } from './merge.service.js';
import { processAudioFiles } from '@core/utils/audio-processor.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
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
  // Plain arrow over a hoisted toggle so vi.clearAllMocks() never wipes it; flip false for the
  // not-detected gate test. Default detected — merge gates on a resolvable ffmpeg path.
  resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null),
}));

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn(),
}));

// The marker-gated recovery sequence (#1418) touches real fs and short-circuits to
// "marker present" under mocked fs (#1391), so it is stubbed here. These unit tests
// assert it is invoked with bookPath; the real on-disk recovery behavior (including
// the post-recovery file-set re-read and F9 minimum re-validation) is covered in
// merge.service.marker.test.ts (real tmpdir).
vi.mock('../utils/recover-interrupted-commit.js', () => ({
  recoverInterruptedCommit: vi.fn().mockResolvedValue(undefined),
}));

// Shared with merge-state.test.ts (#2142) — see __tests__/merge-fixtures.ts.
import {
  BOOK_PATH, STAGING_DIR, mockAuthor, mockBook, processingOverrides, SCAN_RESULT,
  settle, setupHappyPath,
} from './__tests__/merge-fixtures.js';

function createService(opts?: {
  eventHistory?: EventHistoryService;
  eventBroadcaster?: EventBroadcasterService;
  connector?: { notifyRefresh: ReturnType<typeof vi.fn> };
  processing?: Partial<{ outputFormat: 'm4b' | 'mp3'; bitrate: number; keepOriginalBitrate: boolean; maxConcurrentProcessing: number }>;
  tagging?: Partial<{ enabled: boolean; mode: 'populate_missing' | 'overwrite'; embedCover: boolean }>;
  /** Pass `null` to exercise "tag embedding enabled but no tagger wired" (AC10's absent arm). */
  taggingService?: { retagBook: ReturnType<typeof vi.fn> } | null;
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

      // Staging dir created
      expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });

      // Top-level audio files copied (not cover.jpg)
      expect(cp).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'), join(STAGING_DIR, '01.mp3'));
      expect(cp).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'), join(STAGING_DIR, '02.mp3'));
      expect(cp).not.toHaveBeenCalledWith(expect.stringContaining('cover.jpg'), expect.anything());

      // processAudioFiles called on staging dir with mergeBehavior: always (manual Merge
      // always merges by design) and outputFormat taken from the injected settings fixture.
      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ ffmpegPath: '/usr/bin/ffmpeg', mergeBehavior: 'always', outputFormat: processingOverrides.processing.outputFormat }),
        expect.objectContaining({ title: 'The Way of Kings' }),
        expect.objectContaining({ onProgress: expect.any(Function), onStderr: expect.any(Function) }),
        expect.any(AbortSignal),
      );

      // scanAudioDirectory called on staging for verification with derived ffprobe path
      expect(scanAudioDirectory).toHaveBeenCalledWith(STAGING_DIR, {
        ffprobePath: '/usr/bin/ffprobe',
        onWarn: expect.any(Function),
        onDebug: expect.any(Function),
      });

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
    });

    // #1720 — the merge context now carries the library fileFormat + book-level naming
    // tokens (series/seriesPosition/narrator/year/edition), so a merged filename matches
    // the rest of the library instead of collapsing to `${author} - ${title}`.
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
          fileFormat: '{author} - {title}', // default library format, threaded (was previously dropped)
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

    // #1418 — marker convergence runs on bookPath before any staging work
    it('converges the commit-pending marker on bookPath before staging', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      // Recovery invoked on the book path before the source files are copied to staging.
      expect(recoverInterruptedCommit).toHaveBeenCalledWith(BOOK_PATH, expect.any(String), expect.anything());
      const recoverOrder = (recoverInterruptedCommit as Mock).mock.invocationCallOrder[0]!;
      const cpOrder = (cp as Mock).mock.invocationCallOrder[0]!;
      expect(recoverOrder).toBeLessThan(cpOrder);
    });

    // #1852 — a born-hidden temp beside the real files is never eligibility evidence, never
    // copied to staging, and never in originalsToDelete.
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(cp).not.toHaveBeenCalledWith(expect.stringContaining('.02.tmp.mp3'), expect.anything());
      expect(unlink).not.toHaveBeenCalledWith(join(BOOK_PATH, '.02.tmp.mp3'));
      // Only the two real originals were staged and deleted.
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
    });

    // #1852 Change 4 / F25 — the deterministic staging dir is reset to empty before copying,
    // so crash-residue can't be folded into the merge; a failed reset aborts via merge_failed.
    it('#1852: resets the staging dir (rm before the first copy)', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      const firstResetRm = (rm as Mock).mock.invocationCallOrder[0]!;
      const firstCp = (cp as Mock).mock.invocationCallOrder[0]!;
      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(firstResetRm).toBeLessThan(firstCp); // reset happens before any staging copy
    });

    it('#1852: an un-emptyable staging dir aborts the merge via merge_failed (no copy/merge)', async () => {
      setupHappyPath();
      (rm as Mock).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' })); // reset fails
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      expect(cp).not.toHaveBeenCalled();
      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42, reason: 'error' }));
    });

    // #1418 — a recovery failure aborts before any ffmpeg work and emits merge_failed
    it('aborts the merge (no staging, merge_failed) when recovery throws', async () => {
      setupHappyPath();
      (recoverInterruptedCommit as Mock).mockRejectedValueOnce(new Error('recovery failed'));
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      // No ffmpeg/staging work ran, and nothing was committed into bookPath.
      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      // #2099 D2: the abort is BEFORE runStaging, so this execution never claimed the staging
      // path — the catch leaves it exactly as found (it may hold a prior crash's orphan that
      // boot recovery still needs to classify). Asserted on the staging path SPECIFICALLY:
      // `recoverInterruptedCommit` is mocked here, but in production its convergence work
      // legitimately `rm`s scratch siblings before throwing, which AC1 places outside the invariant.
      expect(rm).not.toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42, reason: 'error' }));
    });

    // #1418 (F9) — recovery can shrink the converged folder below the merge minimum, so
    // executeMerge re-reads bookPath AFTER recovery and re-validates the ≥2 minimum. Here the
    // first (enqueue-validation) read sees 2 files; the second (post-recovery) read sees 1.
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

      // No staging/ffmpeg work ran — the guard fired on the post-recovery count.
      expect(processAudioFiles).not.toHaveBeenCalled();
      expect(eventBroadcaster.emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42 }));
    });

    it('with outputFormat mp3: passes mp3 to processAudioFiles and discovers/commits the staged .mp3', async () => {
      // Staging produces a .mp3 instead of a .m4b
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

      const { service } = createService({ processing: { outputFormat: 'mp3' } });

      await service.enqueueMerge(42);
      await settle();

      // (a) outputFormat threaded through to the engine
      expect(processAudioFiles).toHaveBeenCalledWith(
        STAGING_DIR,
        expect.objectContaining({ outputFormat: 'mp3' }),
        expect.any(Object),
        expect.any(Object),
        expect.any(AbortSignal),
      );

      // (b) the staged .mp3 is discovered (no "Staged output not found" throw) and committed
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
      // mockBook has audioBitrate: null by default
      const { service } = createService();
      setupHappyPath();

      await service.enqueueMerge(42);
      await settle();

      // Producer-omit pattern: null audioBitrate results in sourceBitrateKbps
      // key omission from the ProcessingConfig, not explicit undefined
      // (eopt invariant per #939 AC4).
      expect(processAudioFiles).toHaveBeenCalled();
      const config = vi.mocked(processAudioFiles).mock.calls[0]![1];
      expect(config).not.toHaveProperty('sourceBitrateKbps');
    });

    it('does not delete the output file when an original shares the same basename as the staged M4B', async () => {
      // Book already has a top-level .m4b alongside other files
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      // The original mp3s are deleted
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
      // The output file (same basename as staged M4B) is NOT deleted
      expect(unlink).not.toHaveBeenCalledWith(join(BOOK_PATH, 'The Way of Kings.m4b'));
    });

    it('calls enrichBookFromAudio with bookService after successful move', async () => {
      setupHappyPath();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(enrichBookFromAudio).toHaveBeenCalledWith(
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

      // originalsToDelete is topLevelAudioFiles: ['01.mp3', '02.mp3'] (cover.jpg excluded)
      // First unlink fails but second is still attempted
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '01.mp3'));
      expect(unlink).toHaveBeenCalledWith(join(BOOK_PATH, '02.mp3'));
      // Merge still completes: staging dir cleanup runs (success-only path)
      expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
      expect(log.error).not.toHaveBeenCalled();
    });

    // #1707 — connector refresh after the irreversible swap
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
        // The pre-copy staging reset (#1852 Change 4) is the FIRST rm call — let it succeed so the
        // merge proceeds to the swap; only the LATE post-swap cleanup rm throws (what this asserts).
        (rm as Mock).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('rm failed'));
        const notifyRefresh = vi.fn().mockResolvedValue(undefined);
        const { service } = createService({ connector: { notifyRefresh } });

        await service.enqueueMerge(42);
        await settle();

        // The refresh fires before the rm (which is the only step that can throw after the swap),
        // so the late rm failure can't suppress it.
        expect(unlink).toHaveBeenCalled();
        expect(notifyRefresh).toHaveBeenCalledWith('merge', [expect.objectContaining({ bookId: 42 })]);
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

      // stat() must be called on the destination path (book.path/stagedM4b), not the staging path
      const expectedOutputPath = join(BOOK_PATH, 'The Way of Kings.m4b');
      expect(stat).toHaveBeenCalledWith(expectedOutputPath);

      const setMock = (db.update as Mock).mock.results[0]?.value?.set as Mock;
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
        size: 123_456_789,
        updatedAt: expect.any(Date),
      }));
      // Sibling of the post-tag write's F12 fix: the DB mutation contract is payload AND
      // filter, so this pre-existing commit-time write gets its row predicate pinned too.
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
      /**
       * Observation point matters: the stderr deduplicator logs at debug, which the shipped
       * default log level hides, so asserting there would pass while the operator sees
       * nothing. These assert the structured `warnings` channel — log.warn and the
       * merge-complete message.
       */
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

      // Second call should not throw ALREADY_IN_PROGRESS
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

      // rename (move) should NOT have been called — book.path untouched
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

      // Second call should not throw ALREADY_IN_PROGRESS
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

    it('does not call enrichBookFromAudio when scan fails', async () => {
      setupScanFailure();
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      expect(enrichBookFromAudio).not.toHaveBeenCalled();
    });
  });

  describe('enqueueMerge — post-commit enrichment failure', () => {
    it('surfaces enrichmentWarning via merge_complete event when enrichBookFromAudio returns { enriched: false }', async () => {
      setupHappyPath();
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
      const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
      const { service, log } = createService({ eventBroadcaster });

      await service.enqueueMerge(42);
      await settle();

      // Warning logged
      expect(log.warn).toHaveBeenCalled();

      // enrichmentWarning surfaces via merge_complete SSE event
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
      const { service } = createService();

      await service.enqueueMerge(42);
      await settle();

      // rename (move) was called before enrichment
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
      (readdir as Mock).mockResolvedValue(['Chapter 01.m4b']); // only 1 audio file
      const { service } = createService();

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    it('throws MergeError NO_TOP_LEVEL_FILES when only non-audio files are present', async () => {
      (readdir as Mock).mockResolvedValue(['cover.jpg', 'metadata.nfo']);
      const { service } = createService();

      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_TOP_LEVEL_FILES' });
    });

    // #1852 F5 — pre-enqueue eligibility must not count a born-hidden temp as the second file.
    // Load-bearing: one visible + one hidden → still ineligible. Reverting the isHiddenName filter
    // would count 2 and let this book through.
    it('#1852 F5: one visible + one hidden top-level file rejects NO_TOP_LEVEL_FILES at pre-enqueue', async () => {
      (readdir as Mock).mockResolvedValue(['01.mp3', '.02.tmp.mp3']); // 1 real + 1 born-hidden temp
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

      // Second call while first is in progress
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
        // Check that the lock is held during processing
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

      // Lock cleared — second call should not throw ALREADY_IN_PROGRESS
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

      // Second call: reset mocks and try again
      vi.clearAllMocks();
      setupHappyPath();
      await expect(service.enqueueMerge(42)).resolves.toBeDefined();
      await settle();
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
      (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
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
      await service.enqueueMerge(42);
      await settle();

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
      // The retired incrementals never ride along (#2142).
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

      // Merge completed despite SSE failures
      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ bookId: 42 }), expect.any(String));
    });

    // #2099 AC1 splits what used to be one blanket "history rejection never fails the merge"
    // test. The two lifecycle writes now own DIFFERENT failure semantics, so each double is
    // call-specific (keyed on `eventType`) and each test proves exactly one of them.
    it('a rejected merge_started insert aborts the merge before staging (#2099 AC1)', async () => {
      // This describe has no per-test reset, so the negative assertions below would otherwise
      // see earlier tests' staging calls. Clear first, then re-establish the happy-path doubles.
      vi.clearAllMocks();
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

      // Merge completed despite the terminal event-history failure — those writes stay best-effort.
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

      // Wait a tick so the fire-and-forget merge_started emit fires
      await new Promise((r) => process.nextTick(r));

      const emitsBefore = (eventBroadcaster.emit as Mock).mock.calls.length;

      // Second call — should throw without emitting any events
      await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });

      // No additional SSE events from the rejected second request
      expect((eventBroadcaster.emit as Mock).mock.calls.length).toBe(emitsBefore);

      // Only 1 merge_started SSE from the first (accepted) call
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
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
      // The queued book is announced through the snapshot alone (#2142) — the frame that
      // followed the enqueue carries it, title included, in FIFO order.
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
      // AC4 liveness pin: assert the full global start order after the final release, not just
      // pairwise — proves no jump-ahead and that the drain path promotes every queued job.
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

    // #1852 F6 — dequeue-time revalidation (validateDequeueTime) is an independent eligibility gate.
    // A book that qualified at enqueue (2 visible) but is one-visible-plus-one-hidden by the time it
    // is promoted must fail there. Reverting the isHiddenName filter would count the hidden temp as a
    // second file, so book 43 would proceed (merge_started, no merge_failed) — this pins that it does not.
    it('#1852 F6: a queued book that becomes one-visible-plus-one-hidden fails dequeue-time revalidation', async () => {
      const { service, bookService, eventBroadcaster } = createServiceWithBroadcaster();
      const book42 = { ...createMockDbBook({ id: 42, title: 'Book A', path: '/lib/A', status: 'imported' }), authors: [mockAuthor], narrators: [] };
      const book43 = { ...createMockDbBook({ id: 43, title: 'Book B', path: '/lib/B', status: 'imported' }), authors: [mockAuthor], narrators: [] };
      bookService.getById.mockImplementation(async (id: number) => (id === 42 ? book42 : id === 43 ? book43 : null));

      // At enqueue, /lib/B has two real files (43 queues legitimately).
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
      (processAudioFiles as Mock).mockImplementationOnce(async () => { await firstPromise; return { success: true, outputFiles: ['/staging/out.m4b'] }; })
        .mockResolvedValue({ success: true, outputFiles: ['/staging/out.m4b'] });

      await service.enqueueMerge(42); // starts
      await service.enqueueMerge(43); // queues (2 visible at enqueue)

      // Before 43 dequeues, /lib/B loses a real file and gains a born-hidden temp → 1 visible left.
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
      expect(failedFor(43)).toBe(true);   // dequeue-time gate rejected it
      expect(startedFor(43)).toBe(false); // it never proceeded to actual merge work
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

      await service.enqueueMerge(42); // starts (takes slot)
      await service.enqueueMerge(43); // queues

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
      // After book 43 dequeues, some snapshot frame shows book 44 alone at the queue's head —
      // its position (index + 1 = 1) is the FIFO order itself, with no positional event (#2142).
      const stateFrames = emitCalls
        .filter((c: unknown[]) => c[0] === 'merge_state')
        .map((c: unknown[]) => c[1] as { queued: Array<{ book_id: number }> });
      expect(stateFrames.some((f) => f.queued.length === 1 && f.queued[0]!.book_id === 44)).toBe(true);
      expect(emitCalls.map((c: unknown[]) => c[0])).not.toContain('merge_queue_updated');
    });

    it('merge_complete includes enrichmentWarning when enrichment fails', async () => {
      setupHappyPath();
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: false });
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

      // Complete first merge — release + drainQueue promotes book 43 into the freed slot
      resolveFirst();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Book 43 is now the active merge (holding the slot). A new request should queue, not start.
      const result = await service.enqueueMerge(44);
      expect(result.status).toBe('queued');

      resolveSecond();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });

  describe('#1302 maxConcurrentProcessing — semaphore sizing + FIFO under resize', () => {
    // Gated processAudioFiles: each invocation blocks until released, tracking peak concurrency.
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });

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
      expect(startedIds()).toEqual([42]); // only the first has started

      // Releasing the first promotes the queued second
      gate.releaseAll();
      await settle();
      gate.releaseAll();
      await settle();
      expect(startedIds()).toContain(43);
    });

    it('AC4: after a 1→2 capacity raise, enqueuing a newer book promotes the older queued book first (FIFO, no jump-ahead)', async () => {
      const { bookService } = setupMultiBook([42, 43, 44]);
      const gate = gatedProcessing();

      // Mutable concurrency so the test can raise capacity between enqueues.
      const processing = { ...processingOverrides.processing, maxConcurrentProcessing: 1 };
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? processing : cat === 'library' ? { path: '/library' } : undefined)),
        getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn(),
      });
      const { service, startedIds } = buildService(bookService, settingsService);

      // Capacity 1: A (42) active, B (43) queued.
      await service.enqueueMerge(42);
      const bAck = await service.enqueueMerge(43);
      await settle();
      expect(bAck.status).toBe('queued');
      expect(startedIds()).toEqual([42]);

      // Raise capacity, then enqueue a NEWER book C (44).
      processing.maxConcurrentProcessing = 2;
      const cAck = await service.enqueueMerge(44);
      await settle();

      // The older queued B is promoted into the freed slot; the newer C stays queued.
      expect(cAck.status).toBe('queued');
      expect(startedIds()).toContain(43); // B started
      expect(startedIds()).not.toContain(44); // C did NOT jump ahead

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

      // Clamped to 1 — first runs, second queues (not a deadlock where neither runs).
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

      // Mutable concurrency so the test can lower capacity between enqueues.
      const processing = { ...processingOverrides.processing, maxConcurrentProcessing: 2 };
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? processing : cat === 'library' ? { path: '/library' } : undefined)),
        getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn(),
      });
      const { service, startedIds } = buildService(bookService, settingsService);

      // Capacity 2: A (42) + B (43) active.
      await service.enqueueMerge(42);
      await service.enqueueMerge(43);
      await settle();
      expect(startedIds()).toEqual([42, 43]);
      expect(gate.peak()).toBe(2);

      // Operator lowers capacity to 1; the next enqueue applies setMax(1). C (44) queues.
      processing.maxConcurrentProcessing = 1;
      const cAck = await service.enqueueMerge(44);
      await settle();
      expect(cAck.status).toBe('queued');

      // First active merge finishes — but capacity is now 1 and B is still in-flight, so the
      // queued C must NOT start (the old slot-pass would have started it regardless of max).
      gate.releaseOne();
      await settle();
      expect(startedIds()).toEqual([42, 43]); // C still waiting

      // Second active merge finishes — now a slot is genuinely free under max=1, so C starts.
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

      // First attempt: the (only) processing read rejects — must propagate AND leave inProgress clean.
      await expect(service.enqueueMerge(42)).rejects.toThrow('settings cache DB error');

      // Retry for the same book must NOT 409 with ALREADY_IN_PROGRESS (the book was not stranded).
      const ack = await service.enqueueMerge(42);
      expect(ack.status).toBe('started');
    });

    it('#1368 no duplicate settings read: the enqueue validate+size path reads get(\'processing\') once', async () => {
      const { bookService } = setupMultiBook([42, 43]);
      const gate = gatedProcessing();
      const get = vi.fn().mockImplementation((cat: string) => Promise.resolve(cat === 'processing' ? { ...processingOverrides.processing } : cat === 'library' ? { path: '/library' } : undefined));
      const settingsService = inject<SettingsService>({ get, getAll: vi.fn(), set: vi.fn(), patch: vi.fn(), update: vi.fn() });
      const { service } = buildService(bookService, settingsService);

      // A (42) starts and holds the only slot (max=1), gated in processAudioFiles.
      await service.enqueueMerge(42);
      await settle();

      // Isolate the next enqueue's reads — exclude A's validate read and executeMerge's
      // legitimate execution-time read (the F2 distinction: only the enqueue sizing path counts).
      get.mockClear();

      // B (43) queues (no slot, so no executeMerge). Its validate read must be reused for setMax —
      // exactly one processing read across the whole start-vs-queue decision.
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

      // Capacity 1: A (42) active, B (43) queued.
      await service.enqueueMerge(42);
      await service.enqueueMerge(43);
      await settle();
      expect(startedIds()).toEqual([42]);

      // Raise capacity to 3, then enqueue C (44). drainQueue promotes BOTH B (front) and C, so
      // C's acknowledgement must reflect post-drain reality: started, not a stale 'queued' position.
      processing.maxConcurrentProcessing = 3;
      const cAck = await service.enqueueMerge(44);
      await settle();

      expect(cAck).toEqual({ status: 'started', bookId: 44 });
      // FIFO preserved: B started before C.
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
      (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
    }

    describe('cancel from queue', () => {
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
        const lastFailed = failedEvents[failedEvents.length - 1]!.payload as { reason: string };
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
        (processAudioFiles as Mock).mockImplementation(async (_dir: string, _config: unknown, _ctx: unknown, _cb: unknown, signal?: AbortSignal) => {
          // Wait for abort or resolution
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
        const payload = failedEvents[failedEvents.length - 1]!.payload as { reason: string; error: string };
        expect(payload.reason).toBe('cancelled');
      });

      // #2080 — a cancel landing in the cover extract/reattach phase produces a DIFFERENT
      // unsuccessful result than the main encode does (`ffmpeg exited with code null`, with no
      // cover warning attached). It must still classify as cancelled, and must not be reported
      // to the operator as a cover-art degradation.
      it('classifies a cover-phase abort as cancelled, not as a cover-art failure', async () => {
        setupFsMocksForCancel();
        const { service, emitted } = createServiceWithBroadcasterForCancel();

        (processAudioFiles as Mock).mockImplementation(async (
          _dir: string, _config: unknown, _ctx: unknown, _cb: unknown, signal?: AbortSignal,
        ) => {
          await new Promise<void>((resolve) => {
            if (signal) signal.addEventListener('abort', () => resolve(), { once: true });
          });
          // Exactly what an aborted cover phase now yields: the abort rethrown out of
          // withCoverArtPipeline, caught by processAudioFiles, with no cover warning.
          return { success: false, error: 'ffmpeg exited with code null' };
        });

        await service.enqueueMerge(42);
        await new Promise((r) => setTimeout(r, 50));

        const result = await service.cancelMerge(42);
        expect(result.status).toBe('cancelled');
        await new Promise((r) => setTimeout(r, 100));

        const failedEvents = emitted.filter(e => e.event === 'merge_failed');
        const payload = failedEvents[failedEvents.length - 1]!.payload as { reason: string; error: string };
        expect(payload.reason).toBe('cancelled');
        expect(payload.error).not.toContain('Cover art');
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
        await service.enqueueMerge(42);
        await settle();

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

      await service.enqueueMerge(42);
      await settle();

      const snapshotPhases = emitted
        .filter(e => e.event === 'merge_state')
        .flatMap(e => (e.payload as { active: Array<{ phase: string }> }).active.map((a) => a.phase));
      expect(snapshotPhases).toContain('committing');
      expect(snapshotPhases).not.toContain('finalizing');

      // committing must be the last in-flight phase broadcast (before merge_complete)
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

// ============================================================================
// #1838 — merge event provenance: auto-merge events record source 'auto', not 'manual'
// ============================================================================

describe('#1838 merge origin — event provenance', () => {
  /** eventHistory.create calls for a given bookId + eventType. */
  function historyFor(create: Mock, bookId: number, eventType: string) {
    return create.mock.calls
      .map((c) => c[0] as { bookId: number; eventType: string; source: string })
      .filter((e) => e.bookId === bookId && e.eventType === eventType);
  }

  /** Build a service with a captured eventHistory mock and a bookService keyed by the given books. */
  function createServiceWithHistory(books: Array<{ id: number; title: string; path: string }>, maxConcurrentProcessing = 1) {
    const db = createMockDb();
    const byId = new Map(books.map((b) => [b.id, {
      ...createMockDbBook({ id: b.id, title: b.title, path: b.path, status: 'imported' }),
      authors: [mockAuthor], narrators: [],
    }]));
    const bookService = {
      getById: vi.fn(async (id: number) => byId.get(id) ?? null),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const settingsService = createMockSettingsService({
      processing: { ...processingOverrides.processing, maxConcurrentProcessing },
    });
    const create = vi.fn().mockResolvedValue(undefined);
    const eventHistory = { create } as unknown as EventHistoryService;
    const log = createMockLogger();
    const service = new MergeService(
      inject<Db>(db), inject<BookService>(bookService), settingsService,
      inject<FastifyBaseLogger>(log), eventHistory, undefined,
    );
    return { service, bookService, create };
  }

  it('auto immediate-start success records merge_started and merged with source auto', async () => {
    setupHappyPath();
    const { service, create } = createServiceWithHistory([{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }]);

    await service.enqueueMerge(42, 'auto');
    await settle();

    expect(historyFor(create, 42, 'merge_started')[0]?.source).toBe('auto');
    expect(historyFor(create, 42, 'merged')[0]?.source).toBe('auto');
  });

  it('auto immediate-start failure records merge_failed with source auto', async () => {
    (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
    (mkdir as Mock).mockResolvedValue(undefined);
    (cp as Mock).mockResolvedValue(undefined);
    (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
    (rm as Mock).mockResolvedValue(undefined);
    const { service, create } = createServiceWithHistory([{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }]);

    await service.enqueueMerge(42, 'auto');
    await settle();

    const failed = historyFor(create, 42, 'merge_failed');
    expect(failed[0]?.source).toBe('auto');
  });

  it('auto queued path carries source auto while a concurrent manual book stays manual', async () => {
    setupHappyPath();
    // Book 42 (manual) blocks the single worker; book 43 (auto) queues behind it.
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
    (processAudioFiles as Mock)
      .mockImplementationOnce(async () => { await firstPromise; return { success: true, outputFiles: [STAGING_DIR + '/out.m4b'] }; })
      .mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/out.m4b'] });
    const { service, create } = createServiceWithHistory(
      [{ id: 42, title: 'Book A', path: '/lib/A' }, { id: 43, title: 'Book B', path: '/lib/B' }],
    );

    await service.enqueueMerge(42, 'manual');
    const ack = await service.enqueueMerge(43, 'auto');
    expect(ack.status).toBe('queued');

    resolveFirst();
    await settle();

    // Per-bookId origin isolation across concurrent entries.
    expect(historyFor(create, 42, 'merge_started')[0]?.source).toBe('manual');
    expect(historyFor(create, 42, 'merged')[0]?.source).toBe('manual');
    expect(historyFor(create, 43, 'merge_started')[0]?.source).toBe('auto');
    expect(historyFor(create, 43, 'merged')[0]?.source).toBe('auto');
  });

  it('cancel of a queued auto merge emits merge_failed(cancelled) with source auto', async () => {
    setupHappyPath();
    // Book 42 (manual) never resolves so book 43 (auto) stays queued and cancellable.
    (processAudioFiles as Mock).mockImplementation(async () => new Promise(() => {}));
    const { service, create } = createServiceWithHistory(
      [{ id: 42, title: 'Book A', path: '/lib/A' }, { id: 43, title: 'Book B', path: '/lib/B' }],
    );

    await service.enqueueMerge(42, 'manual');
    await service.enqueueMerge(43, 'auto');

    const result = await service.cancelMerge(43);
    expect(result.status).toBe('cancelled');

    const failed = historyFor(create, 43, 'merge_failed');
    expect(failed[0]?.source).toBe('auto');
    expect(failed[0]).toMatchObject({ reason: { error: 'Cancelled by user' } });
  });

  it('rejected auto enqueue leaves no stale origin — a later manual merge records source manual (F1)', async () => {
    // Pre-flight NO_TOP_LEVEL_FILES: only one top-level audio file rejects validateBookForMerge.
    (readdir as Mock).mockResolvedValue(['01.mp3']);
    const { service, create } = createServiceWithHistory([{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }]);

    await expect(service.enqueueMerge(42, 'auto')).rejects.toThrow(/No top-level audio files/);
    expect(historyFor(create, 42, 'merge_started')).toHaveLength(0);
    expect(historyFor(create, 42, 'merged')).toHaveLength(0);

    // Fix the condition and enqueue a manual merge of the SAME book — it must not inherit 'auto'.
    setupHappyPath();
    await service.enqueueMerge(42);
    await settle();

    expect(historyFor(create, 42, 'merge_started')[0]?.source).toBe('manual');
    expect(historyFor(create, 42, 'merged')[0]?.source).toBe('manual');
  });

  it('origin is cleared after a merge completes — a subsequent same-book merge uses the new origin', async () => {
    setupHappyPath();
    const { service, create } = createServiceWithHistory([{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }]);

    await service.enqueueMerge(42, 'auto');
    await settle();
    await service.enqueueMerge(42, 'manual');
    await settle();

    // Two sequential merges of the same bookId record their OWN origin, in order.
    expect(historyFor(create, 42, 'merged').map((e) => e.source)).toEqual(['auto', 'manual']);
  });
});

// ============================================================================
// #2078 Layer 2 — post-merge re-tag (AC9–AC15)
//
// Layer 1 (in `src/core/utils/audio-processor.ts`) only carries the SOURCE parts' tags
// forward. When Tag Embedding is on, the merged output must additionally be re-tagged from
// canonical DB state — through the existing `retagBook`, so no second hydrated-book → tag
// projection is introduced.
// ============================================================================

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

/** A tagger whose `retagBook` resolves to `result`. */
function tagger(result: RetagResult = retagResult()) {
  return { retagBook: vi.fn().mockResolvedValue(result) };
}

const TAGGING_ON = { enabled: true, mode: 'overwrite' as const, embedCover: true };

describe('#2078 post-merge re-tag', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls retagBook(bookId) exactly once, with no overrides, when tag embedding is on (AC10)', async () => {
    setupHappyPath();
    const tagging = tagger();
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    // The ABSENCE of a second argument is the point: passing a locally-built metadata object
    // (or mode/embedCover overrides) would fork the canonical projection and let merge-time
    // tagging drift from the manual Re-tag button.
    expect(tagging.retagBook).toHaveBeenCalledTimes(1);
    expect(tagging.retagBook).toHaveBeenCalledWith(42);
    expect(tagging.retagBook.mock.calls[0]).toHaveLength(1);
  });

  it('does not start the tag write until the merge commit has landed the output (AC10)', async () => {
    setupHappyPath();
    // Hold the commit's staging→bookPath rename open. That rename IS the moment the merged file
    // appears at `book.path`, and `retagBook` resolves its working directory from `book.path`
    // itself — started any earlier it would tag the soon-to-be-deleted source parts and could
    // not see the merged output or the folder cover.
    let releaseCommit!: () => void;
    const committed = new Promise<void>((res) => { releaseCommit = res; });
    (rename as Mock).mockImplementation(() => committed);

    const tagging = tagger();
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    expect(rename).toHaveBeenCalledWith(join(STAGING_DIR, 'The Way of Kings.m4b'), MERGED_OUTPUT);
    // Moving retagMergedOutput above commitMerge makes this the failing line.
    expect(tagging.retagBook).not.toHaveBeenCalled();

    releaseCommit();
    await settle();

    expect(tagging.retagBook).toHaveBeenCalledWith(42);
  });

  it('survives a rejecting tagging-settings read — the merge is already committed (AC10)', async () => {
    setupHappyPath();
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const tagging = tagger();
    const { service, settingsService, log } = createService({
      tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster,
    });
    // Only the tagging read rejects; every other category still resolves, so this isolates the
    // post-commit lookup rather than failing the merge somewhere upstream.
    const realGet = (settingsService.get as Mock).getMockImplementation()!;
    (settingsService.get as Mock).mockImplementation((category: string) =>
      category === 'tagging'
        ? Promise.reject(new Error('settings store unavailable'))
        : realGet(category));

    await service.enqueueMerge(42);
    await settle();

    // By this point commitMerge has deleted the originals — reporting merge_failed here would
    // tell the operator a completed, irreversible merge did not happen.
    expect(log.warn).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith(
      'merge_complete', expect.objectContaining({ success: true }),
    );
    expect(vi.mocked(eventBroadcaster.emit).mock.calls.some((c) => c[0] === 'merge_failed')).toBe(false);
    expect(tagging.retagBook).not.toHaveBeenCalled();
    expect(enrichBookFromAudio).toHaveBeenCalled();
  });

  it('never calls retagBook when tag embedding is off — Layer 1 alone governs (AC14)', async () => {
    setupHappyPath();
    const tagging = tagger();
    const { service } = createService({
      tagging: { enabled: false, mode: 'overwrite', embedCover: true },
      taggingService: tagging,
    });

    const ack = await service.enqueueMerge(42);
    await settle();

    // retagBook has no `enabled` gate of its own (it is the manual-action entry point), so a
    // missing gate here would silently re-tag on every merge with the setting off.
    expect(tagging.retagBook).not.toHaveBeenCalled();
    expect(ack).toEqual({ status: 'started', bookId: 42 });
    expect(enrichBookFromAudio).toHaveBeenCalled();
  });

  it.each([
    ['a plain Error', new Error('ffmpeg blew up')],
    ['a RetagError', new RetagError('PATH_MISSING', 'Book path does not exist on disk')],
  ])('survives a rejected retagBook (%s) — merge still reports success (AC10)', async (_label, error) => {
    setupHappyPath();
    const tagging = { retagBook: vi.fn().mockRejectedValue(error) };
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service, log } = createService({ tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(log.warn).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith(
      'merge_complete', expect.objectContaining({ success: true }),
    );
    // The on-disk merge succeeded; a tagging failure must not convert it into a merge failure.
    expect(log.error).not.toHaveBeenCalled();
    expect(enrichBookFromAudio).toHaveBeenCalled();
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
    expect(enrichBookFromAudio).toHaveBeenCalled();
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
    expect(enrichBookFromAudio).toHaveBeenCalled();
  });

  /** Count the `stat()` reads taken against the committed merge output. */
  function statsOnOutput(): number {
    return vi.mocked(stat).mock.calls.filter((c) => c[0] === MERGED_OUTPUT).length;
  }

  it('takes the size stat only AFTER the tag rewrite resolves (AC11)', async () => {
    setupHappyPath();
    // tagFile rewrites the file through a temp + atomic rename, so commitMerge's stat is stale
    // the moment a tag lands.
    const sizes = [500_000_000, 500_004_096];
    (stat as Mock).mockImplementation(async () => ({ size: sizes.shift() ?? 500_004_096 }));

    // Gate `retagBook` rather than feeding two values and reading the second: a stat hoisted
    // above `await retagBook` consumes that same second value and leaves a value-only
    // assertion green. Holding the tag write open makes the ORDER the observable.
    let release!: (r: RetagResult) => void;
    const gate = new Promise<RetagResult>((res) => { release = res; });
    const tagging = { retagBook: vi.fn().mockReturnValue(gate) };
    const { service, db } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    expect(tagging.retagBook).toHaveBeenCalled();
    // Only commitMerge's own stat so far — the post-tag one must not have been taken yet.
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

    // Gate the post-tag update's `where()` terminus. Inspecting the synchronous `set()` call
    // cannot see a dropped `await` — the call trace is identical either way (the repo's
    // issuance-vs-persistence trap). Only a pending terminus can.
    let releasePersist!: () => void;
    const persisted = new Promise<void>((res) => { releasePersist = res; });
    const gatedWhere = vi.fn().mockImplementation(() => ({
      // Thenable only: production awaits this terminus directly and never calls `.returning()`.
      then: (onOk: unknown, onErr: unknown) =>
        persisted.then(() => undefined).then(onOk as never, onErr as never),
    }));

    // Discriminate the post-tag update from commitMerge's by TAG STATE, not call index: the
    // post-tag write is by definition the one issued after `retagBook` resolved, so this stays
    // correct however many updates either step makes.
    let tagWriteDone = false;
    const tagging = {
      retagBook: vi.fn().mockImplementation(async () => { tagWriteDone = true; return retagResult(); }),
    };
    const eventBroadcaster = { emit: vi.fn() } as unknown as EventBroadcasterService;
    const { service, db } = createService({ tagging: TAGGING_ON, taggingService: tagging, eventBroadcaster });
    (db.update as Mock).mockImplementation(() =>
      tagWriteDone ? { set: vi.fn().mockReturnValue({ where: gatedWhere }) } : mockDbChain());

    await service.enqueueMerge(42);
    await settle();

    // The write was ISSUED, but the merge must not have proceeded past it.
    expect(gatedWhere).toHaveBeenCalledTimes(1);
    expect(enrichBookFromAudio).not.toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit).mock.calls.some((c) => c[0] === 'merge_complete')).toBe(false);

    releasePersist();
    await settle();

    expect(enrichBookFromAudio).toHaveBeenCalled();
    expect(vi.mocked(eventBroadcaster.emit)).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ success: true }));
  });

  it('scopes the final size write to exactly the merged book row (AC11)', async () => {
    setupHappyPath();
    (stat as Mock).mockResolvedValue({ size: 500_004_096 });

    const capturedWhere: unknown[] = [];
    let tagWriteDone = false;
    const tagging = {
      retagBook: vi.fn().mockImplementation(async () => { tagWriteDone = true; return retagResult(); }),
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

    // A payload-only assertion passes with the WHERE deleted, widened, or pointed at another
    // book — which would rewrite the wrong rows' size.
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

    // commitMerge's own 'merge' refresh (the just-deleted originals) stays where it is; this
    // second 'metadata' refresh points connectors at the finished, tagged file.
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
    // Gate retagBook's resolution rather than comparing call order: a call-order assertion is
    // satisfied by an un-awaited retagBook, which is exactly the bug this pins.
    let release!: (r: RetagResult) => void;
    const gate = new Promise<RetagResult>((res) => { release = res; });
    const tagging = { retagBook: vi.fn().mockReturnValue(gate) };
    const { service } = createService({ tagging: TAGGING_ON, taggingService: tagging });

    await service.enqueueMerge(42);
    await settle();

    expect(tagging.retagBook).toHaveBeenCalled();
    expect(enrichBookFromAudio).not.toHaveBeenCalled();

    release(retagResult());
    await settle();

    expect(enrichBookFromAudio).toHaveBeenCalled();
  });
});

/**
 * #2099 AC1 — the durable-start invariant.
 *
 * Boot recovery detects an interrupted merge purely from the event log, so for any
 * MergeService constructed WITH an EventHistoryService (i.e. every production instance),
 * no execution may create, write to or delete `.<book>.merge-tmp` unless its `merge_started`
 * row is committed. Two mechanics enforce it: the awaited start insert, and the
 * `stagingOwned` gate on the catch's cleanup.
 *
 * Assertions here target the STAGING PATH specifically, never a total filesystem-call count:
 * admission has already `readdir`'d `book.path` before `executeMerge` is launched
 * (merge.service.ts validateBookForMerge/validateDequeueTime) and `resolveFfmpegPath()` may
 * probe on the cold path — both sit outside the invariant by design.
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

    // The insert is still pending: nothing has been created in, copied into, or removed from
    // the staging path — and recovery has not run either (it is downstream of the await).
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'merge_started' }));
    expect(recoverInterruptedCommit).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());
    expect(cp).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('.merge-tmp'));
    expect(rm).not.toHaveBeenCalledWith(STAGING_DIR, expect.anything());

    releaseInsert();
    await settle();

    // Once it commits, the merge proceeds through staging exactly as before.
    expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });
    expect(processAudioFiles).toHaveBeenCalled();
  });

  it('a rejected insert aborts with merge_failed and leaves a prior crash’s orphan intact', async () => {
    // Pre-seed the staging path with an orphan from an earlier crash — the exact state boot
    // recovery exists to classify. An unconditional catch-cleanup would delete it here,
    // downgrading a `pre-commit` candidate to `no-staging` and forfeiting its re-queue.
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
    // The orphan survives — nothing in this execution addressed the staging path at all.
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
        // The SSE emit runs BETWEEN the create() invocation and the await, so by the time this
        // rejection is observed the emit has already been recorded.
        insertInvoked = true;
        return Promise.reject(new Error('DB write failed'));
      }),
    } as unknown as EventHistoryService;
    const { service } = createService({ eventHistory, eventBroadcaster });

    await service.enqueueMerge(42);
    await settle();

    expect(insertInvoked).toBe(true);
    // The admission of the merge also puts a `merge_state` snapshot frame on the wire (#2129);
    // this assertion is about the DISCRETE merge events, so filter the snapshots out rather
    // than pinning an absolute index.
    const discrete = emitted.filter((event) => event !== 'merge_state');
    expect(discrete[0]).toBe('merge_started');
    expect(emitted).toContain('merge_failed');
  });

  it('out of domain: with no eventHistory wired the merge stages, commits and cleans as before', async () => {
    setupHappyPath();
    const { service } = createService(); // no eventHistory — outside AC1's domain entirely

    await service.enqueueMerge(42);
    await settle();

    expect(mkdir).toHaveBeenCalledWith(STAGING_DIR, { recursive: true });
    expect(processAudioFiles).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith(join(STAGING_DIR, 'The Way of Kings.m4b'), join(BOOK_PATH, 'The Way of Kings.m4b'));
    expect(rm).toHaveBeenCalledWith(STAGING_DIR, { recursive: true, force: true });
  });
});

