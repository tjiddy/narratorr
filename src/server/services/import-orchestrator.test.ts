import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImportOrchestrator } from './import-orchestrator.js';
import type { ImportService, ImportResult, ImportContext } from './import.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { RetrySearchDeps } from './retry-search.js';
import { createMockLogger, createMockSettingsService, inject } from '../__tests__/helpers.js';
import { ContentFailureError } from '../utils/import-helpers.js';

vi.mock('./rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/enqueue-auto-import.js', () => ({
  enqueueAutoImport: vi.fn().mockResolvedValue(true),
}));

import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';

import { blacklistAndRetrySearch } from './rejection-helpers.js';

// Pass through the real isContentFailure implementation; spy on the remaining import steps.
vi.mock('../utils/import-steps.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    emitDownloadImporting: vi.fn(),
    emitBookImporting: vi.fn(),
    emitImportStatusSuccess: vi.fn(),
    emitImportFailure: vi.fn(),
    notifyImportComplete: vi.fn(),
    notifyImportFailure: vi.fn(),
    recordImportEvent: vi.fn(),
    recordImportFailedEvent: vi.fn(),
    embedTagsForImport: vi.fn().mockResolvedValue(undefined),
    runImportPostProcessing: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  emitDownloadImporting, emitBookImporting, emitImportStatusSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
  embedTagsForImport, runImportPostProcessing,
} from '../utils/import-steps.js';

// This suite owns OPF orchestration; opf-writer.test.ts owns reload, XML, and failure behavior.
vi.mock('../utils/opf-writer.js', () => ({
  writeOpfForImport: vi.fn().mockResolvedValue(undefined),
}));
import { writeOpfForImport } from '../utils/opf-writer.js';
import type { BookService } from './book.service.js';

// The orchestrator only reads the filesystem for auto-merge admission.
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
}));
import { readdir } from 'node:fs/promises';
import type { MergeService } from './merge.service.js';
import { MergeError } from './merge.service.js';

function createMockImportService(overrides?: Partial<Record<string, unknown>>): ImportService {
  return inject<ImportService>({
    importDownload: vi.fn(),
    getImportContext: vi.fn(),
    getEligibleDownloads: vi.fn().mockResolvedValue([]),
    ...overrides,
  });
}

const mockContext: ImportContext = {
  downloadId: 1,
  downloadTitle: 'The Way of Kings [2010]',
  downloadStatus: 'completed',
  bookId: 1,
  bookTitle: 'The Way of Kings',
  bookStatus: 'wanted',
  bookStatusAtGrab: 'wanted',
  bookPath: null,
  authorName: 'Brandon Sanderson',
  book: {
    id: 1, title: 'The Way of Kings', status: 'wanted', path: null,
    narrators: [{ name: 'Michael Kramer' }], seriesName: 'Stormlight', seriesPosition: 1, coverUrl: '/covers/1.jpg',
  } as ImportContext['book'],
  infoHash: 'abc123',
  guid: null,
};

const mockResult: ImportResult = {
  downloadId: 1,
  bookId: 1,
  targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
  fileCount: 12,
  totalSize: 500_000_000,
};

describe('ImportOrchestrator', () => {
  let importService: ImportService;
  let settingsService: SettingsService;
  let log: FastifyBaseLogger;
  let notifier: NotifierService;
  let tagging: TaggingService;
  let eventHistory: EventHistoryService;
  let broadcaster: EventBroadcasterService;
  let connector: { notifyRefresh: ReturnType<typeof vi.fn> };
  let bookService: BookService;
  let mergeService: MergeService;
  let orchestrator: ImportOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();

    importService = createMockImportService({
      getImportContext: vi.fn().mockResolvedValue(mockContext),
      importDownload: vi.fn().mockResolvedValue(mockResult),
    });
    settingsService = createMockSettingsService();
    log = inject<FastifyBaseLogger>(createMockLogger());
    notifier = inject<NotifierService>({ notify: vi.fn().mockResolvedValue(undefined) });
    tagging = inject<TaggingService>({ tagBook: vi.fn().mockResolvedValue({ tagged: 1, skipped: 0, failed: 0 }) });
    eventHistory = inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) });
    broadcaster = inject<EventBroadcasterService>({ emit: vi.fn() });
    connector = { notifyRefresh: vi.fn().mockResolvedValue(undefined) };
    bookService = inject<BookService>({ getById: vi.fn().mockResolvedValue(null) });
    mergeService = inject<MergeService>({
      enqueueMerge: vi.fn().mockResolvedValue({ status: 'queued', bookId: 1 }),
      cancelMerge: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    });
    vi.mocked(readdir).mockResolvedValue([] as never);

    orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService, mergeService);

    // Wire the shared fixture; unwired-contract tests construct separate instances.
    const defaultBlacklistService = inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) });
    const defaultRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
    orchestrator.wire({
      bookImportService: {} as never,
      blacklistService: defaultBlacklistService,
      retrySearchDeps: defaultRetrySearchDeps,
      nudgeImportWorker: vi.fn(),
    });
  });

  describe('importDownload — success path', () => {
    it('loads import context and calls importService.importDownload()', async () => {
      const result = await orchestrator.importDownload(1);

      expect(importService.getImportContext).toHaveBeenCalledWith(1);
      expect(importService.importDownload).toHaveBeenCalledWith(1, undefined);
      expect(result).toEqual(mockResult);
    });

    it('emits book_status_change SSE at import start (always)', async () => {
      await orchestrator.importDownload(1);

      expect(emitBookImporting).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 1, bookStatus: 'wanted',
      }));
    });

    it('emits download_status_change SSE when previous status is not importing', async () => {
      await orchestrator.importDownload(1);

      expect(emitDownloadImporting).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 1, downloadStatus: 'completed',
      }));
    });

    it('skips download_status_change SSE when previous status is already importing (approve path dedupe)', async () => {
      const approveCtx = { ...mockContext, downloadStatus: 'importing' };
      (importService.getImportContext as ReturnType<typeof vi.fn>).mockResolvedValue(approveCtx);

      await orchestrator.importDownload(1);

      expect(emitDownloadImporting).not.toHaveBeenCalled();
      expect(emitBookImporting).toHaveBeenCalled();
    });

    it('dispatches tagging after successful import (best-effort), with no caller-supplied projection', async () => {
      await orchestrator.importDownload(1);

      // bookService is the embed's own in-section re-read (#2461); without it the helper would
      // have no way to notice the folder was vacated while it was queued.
      expect(embedTagsForImport).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 1, targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings', bookService,
      }));
      // #2480: the stale pre-import projection is gone from the payload. `not.objectContaining`
      // would pass on a present-but-undefined key, so the key itself is what gets asserted.
      const embedArgs = vi.mocked(embedTagsForImport).mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(embedArgs).not.toHaveProperty('book');
    });

    it('skips the tag embed with a warn when no book service is wired, and still runs every later side effect', async () => {
      const degraded = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector));

      await expect(degraded.importDownload(1)).resolves.toEqual(mockResult);

      expect(embedTagsForImport).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        { bookId: 1 },
        'Tag embedding skipped during import — no book service wired',
      );
      expect(runImportPostProcessing).toHaveBeenCalled();
      expect(emitImportStatusSuccess).toHaveBeenCalled();
      expect(connector.notifyRefresh).toHaveBeenCalled();
    });

    it('dispatches post-processing after tagging (best-effort)', async () => {
      await orchestrator.importDownload(1);

      expect(runImportPostProcessing).toHaveBeenCalledWith(expect.objectContaining({
        targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
        bookTitle: 'The Way of Kings',
        // Survives #2480's context-projection removal: the script contract still reads ctx.authorName.
        bookAuthor: 'Brandon Sanderson',
      }));
    });

    it('dispatches the OPF write after tagging, passing the writeOpf setting, fresh bookId, and target path (#1669)', async () => {
      settingsService = createMockSettingsService({ tagging: { writeOpf: true } });
      orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService);

      await orchestrator.importDownload(1);

      expect(writeOpfForImport).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        bookService,
        bookId: 1,
        bookFolder: '/audiobooks/Brandon Sanderson/The Way of Kings',
      }));
      // The helper reloads by bookId instead of accepting the stale pre-enrichment snapshot.
      const opfArg = vi.mocked(writeOpfForImport).mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(opfArg).not.toHaveProperty('book');
    });

    it('opts the download-import call site into divergence preservation as source `auto` (#2297 AC9/AC15)', async () => {
      settingsService = createMockSettingsService({ tagging: { writeOpf: true } });
      orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService);

      await orchestrator.importDownload(1);

      // A missing flag must red here, not only in the writer's own suite.
      expect(vi.mocked(writeOpfForImport).mock.calls[0]![0].preserve).toEqual({ source: 'auto', eventHistory });
    });

    it('passes enabled:false to the OPF helper when writeOpf is disabled (default)', async () => {
      await orchestrator.importDownload(1);

      expect(writeOpfForImport).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, bookId: 1 }));
    });

    it('OPF write failure is nonfatal — import resolves, later side effects still run, and log.warn records the continuation (#1669, F1)', async () => {
      settingsService = createMockSettingsService({ tagging: { writeOpf: true } });
      orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService);
      vi.mocked(writeOpfForImport).mockRejectedValueOnce(new Error('disk full'));

      await expect(orchestrator.importDownload(1)).resolves.toEqual(mockResult);

      expect(runImportPostProcessing).toHaveBeenCalled();
      expect(emitImportStatusSuccess).toHaveBeenCalled();
      expect(connector.notifyRefresh).toHaveBeenCalled();

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        'OPF write failed during import — continuing',
      );
    });

    it('emits SSE status transitions after successful import (no import_complete — owned by queue worker, #1108)', async () => {
      await orchestrator.importDownload(1);

      expect(emitImportStatusSuccess).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 1,
      }));
      // Queue workers, not this status helper, own completion titles.
      const callArg = vi.mocked(emitImportStatusSuccess).mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(callArg).not.toHaveProperty('bookTitle');
    });

    it('dispatches notification on import success', async () => {
      await orchestrator.importDownload(1);

      expect(notifyImportComplete).toHaveBeenCalledWith(expect.objectContaining({
        bookTitle: 'The Way of Kings', authorName: 'Brandon Sanderson',
        targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings', fileCount: 12,
      }));
    });

    it('records event history on import success', async () => {
      await orchestrator.importDownload(1);

      expect(recordImportEvent).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 1, bookTitle: 'The Way of Kings', authorName: 'Brandon Sanderson',
        downloadId: 1, targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
        fileCount: 12, totalSize: 500_000_000,
      }));
    });

    it('returns ImportResult from importService', async () => {
      const result = await orchestrator.importDownload(1);
      expect(result).toEqual(mockResult);
    });

    it('enqueues a connector refresh on import success', async () => {
      await orchestrator.importDownload(1);

      expect(connector.notifyRefresh).toHaveBeenCalledWith('import', [
        expect.objectContaining({
          bookId: 1,
          title: 'The Way of Kings',
          authorName: 'Brandon Sanderson',
          libraryPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
        }),
      ]);
    });

    it('forwards optional callbacks bag to importService.importDownload (#681)', async () => {
      const callbacks = { setPhase: vi.fn().mockResolvedValue(undefined), emitProgress: vi.fn() };
      await orchestrator.importDownload(1, callbacks);

      expect(importService.importDownload).toHaveBeenCalledWith(1, callbacks);
    });
  });

  describe('importDownload — failure path', () => {
    const importError = new Error('Import pipeline crashed');

    beforeEach(() => {
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(importError);
    });

    it('dispatches failure SSE with the real prior lifecycle (snapshot) as reverted status', async () => {
      await expect(orchestrator.importDownload(1)).rejects.toThrow('Import pipeline crashed');

      expect(emitImportFailure).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 1, revertedBookStatus: 'wanted',
      }));
    });

    it('dispatches failure notification when importService.importDownload throws', async () => {
      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(notifyImportFailure).toHaveBeenCalledWith(expect.objectContaining({
        downloadTitle: 'The Way of Kings [2010]', error: importError,
      }));
    });

    it('records import_failed event when importService.importDownload throws', async () => {
      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(recordImportFailedEvent).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 1, bookTitle: 'The Way of Kings', downloadId: 1, source: 'auto', error: importError,
      }));
    });

    it('rethrows the original error after dispatching failure side effects', async () => {
      await expect(orchestrator.importDownload(1)).rejects.toBe(importError);
    });

    it('uses the real prior lifecycle (failed) even when the book has a path — path no longer drives the value', async () => {
      const failedCtx = { ...mockContext, bookStatusAtGrab: 'failed' as const, bookPath: '/audiobooks/old/path' };
      (importService.getImportContext as ReturnType<typeof vi.fn>).mockResolvedValue(failedCtx);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(emitImportFailure).toHaveBeenCalledWith(expect.objectContaining({
        revertedBookStatus: 'failed',
      }));
    });

    it('falls back to the conservative REVERT_FALLBACK_STATUS when the snapshot is null (legacy rows)', async () => {
      const legacyCtx = { ...mockContext, bookStatusAtGrab: null, bookPath: '/audiobooks/old/path' };
      (importService.getImportContext as ReturnType<typeof vi.fn>).mockResolvedValue(legacyCtx);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(emitImportFailure).toHaveBeenCalledWith(expect.objectContaining({
        revertedBookStatus: 'imported',
      }));
    });
  });

  describe('importDownload — side effect isolation', () => {
    it('tagging failure does not prevent post-processing', async () => {
      vi.mocked(embedTagsForImport).mockRejectedValueOnce(new Error('tag failed'));

      const result = await orchestrator.importDownload(1);

      expect(result).toEqual(mockResult);
      expect(runImportPostProcessing).toHaveBeenCalled();
    });

    it('post-processing failure does not affect import result', async () => {
      vi.mocked(runImportPostProcessing).mockRejectedValueOnce(new Error('script died'));

      const result = await orchestrator.importDownload(1);

      expect(result).toEqual(mockResult);
      expect(emitImportStatusSuccess).toHaveBeenCalled();
    });

    it('all fire-and-forget side effects dispatched even when best-effort fails', async () => {
      vi.mocked(embedTagsForImport).mockRejectedValueOnce(new Error('tag failed'));
      vi.mocked(runImportPostProcessing).mockRejectedValueOnce(new Error('script died'));

      await orchestrator.importDownload(1);

      expect(emitImportStatusSuccess).toHaveBeenCalled();
      expect(notifyImportComplete).toHaveBeenCalled();
      expect(recordImportEvent).toHaveBeenCalled();
    });
  });

  describe('auto-merge multi-file downloads (#1836)', () => {
    function withToggle(autoMergeDownloads: boolean): ImportOrchestrator {
      const svc = createMockSettingsService({ processing: { autoMergeDownloads } });
      return new ImportOrchestrator(importService, svc, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService, mergeService);
    }

    it('toggle ON + live top-level count ≥ 2 → enqueues exactly one merge for the book id', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3', '03.mp3', 'cover.jpg'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).toHaveBeenCalledTimes(1);
      // Explicit provenance prevents unattended merges being recorded as manual.
      expect(mergeService.enqueueMerge).toHaveBeenCalledWith(1, 'auto');
      // Admission reads the committed target rather than source-result counts.
      expect(readdir).toHaveBeenCalledWith('/audiobooks/Brandon Sanderson/The Way of Kings');
    });

    it('toggle ON + live top-level count 1 → does not enqueue (single-file download)', async () => {
      vi.mocked(readdir).mockResolvedValue(['audiobook.m4b'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).not.toHaveBeenCalled();
    });

    it('#2495: two top-level .mp4 files count as 2 and enqueue an auto merge', async () => {
      vi.mocked(readdir).mockResolvedValue(['Part 1.mp4', 'Part 2.mp4', 'cover.jpg'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).toHaveBeenCalledTimes(1);
      expect(mergeService.enqueueMerge).toHaveBeenCalledWith(1, 'auto');
    });

    it('#2495: a lone .mp4 is a single-file download and enqueues nothing', async () => {
      vi.mocked(readdir).mockResolvedValue(['FortuneFunhouseMissFortuneMysteriesBook19.mp4'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, topLevelAudioCount: 1 }),
        'Auto-merge skipped — fewer than 2 top-level audio files',
      );
    });

    // Hidden staging files must not inflate the live admission count.
    it('#1852 F4: toggle ON + one visible + one hidden top-level file → does not enqueue', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '.02.tmp.mp3'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).not.toHaveBeenCalled();
    });

    it('#1852 F4 positive twin: toggle ON + two visible + one hidden → enqueues exactly one merge', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3', '.03.tmp.mp3'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).toHaveBeenCalledTimes(1);
      expect(mergeService.enqueueMerge).toHaveBeenCalledWith(1, 'auto');
    });

    it('toggle OFF → never enqueues, even with a multi-file committed folder', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3'] as never);
      const orch = withToggle(false);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).not.toHaveBeenCalled();
    });

    it('counts a live top-level readdir, NOT the recursive source ImportResult.fileCount', async () => {
      vi.mocked(readdir).mockResolvedValue(['audiobook.m4b', 'disc1'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).not.toHaveBeenCalled();
    });

    it('enqueues on a live ≥2 count even when the persisted topLevelAudioFileCount is a stale 0 (enrichment-failure case)', async () => {
      bookService = inject<BookService>({ getById: vi.fn().mockResolvedValue({ id: 1, topLevelAudioFileCount: 0 }) });
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3'] as never);
      const svc = createMockSettingsService({ processing: { autoMergeDownloads: true } });
      const orch = new ImportOrchestrator(importService, svc, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService, mergeService);

      await orch.importDownload(1);

      expect(mergeService.enqueueMerge).toHaveBeenCalledWith(1, 'auto');
    });

    it('enqueues only after the awaited tag/OPF/script side effects, and not blocked on the fire-and-forget calls', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3'] as never);
      const orch = withToggle(true);

      await orch.importDownload(1);

      const enqueueOrder = vi.mocked(mergeService.enqueueMerge).mock.invocationCallOrder[0]!;
      expect(enqueueOrder).toBeGreaterThan(vi.mocked(embedTagsForImport).mock.invocationCallOrder[0]!);
      expect(enqueueOrder).toBeGreaterThan(vi.mocked(writeOpfForImport).mock.invocationCallOrder[0]!);
      expect(enqueueOrder).toBeGreaterThan(vi.mocked(runImportPostProcessing).mock.invocationCallOrder[0]!);
      expect(enqueueOrder).toBeGreaterThan(vi.mocked(emitImportStatusSuccess).mock.invocationCallOrder[0]!);
      expect(enqueueOrder).toBeGreaterThan(vi.mocked(recordImportEvent).mock.invocationCallOrder[0]!);
    });

    it('idempotent within a process lifetime — an ALREADY_QUEUED rejection is swallowed at debug, import unchanged', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3'] as never);
      vi.mocked(mergeService.enqueueMerge).mockRejectedValueOnce(new MergeError('Merge already queued for this book', 'ALREADY_QUEUED'));
      const orch = withToggle(true);

      const result = await orch.importDownload(1);

      expect(result).toEqual(mockResult);
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, code: 'ALREADY_QUEUED' }),
        expect.stringContaining('idempotent'),
      );
      expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Auto-merge enqueue failed'));
    });

    it('pre-enqueue admission rejection (ffmpeg unconfigured) is swallowed at warn, import result unchanged, no merge_failed recorded', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3'] as never);
      vi.mocked(mergeService.enqueueMerge).mockRejectedValueOnce(new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED'));
      const orch = withToggle(true);

      const result = await orch.importDownload(1);

      expect(result).toEqual(mockResult);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        expect.stringContaining('Auto-merge enqueue failed'),
      );
      // The orchestrator never records merge_failed; only MergeService's mid-run path owns that event.
      expect(recordImportFailedEvent).not.toHaveBeenCalled();
    });

    it('a generic enqueue rejection never fails or reverts the import', async () => {
      vi.mocked(readdir).mockResolvedValue(['01.mp3', '02.mp3'] as never);
      vi.mocked(mergeService.enqueueMerge).mockRejectedValueOnce(new Error('unexpected'));
      const orch = withToggle(true);

      await expect(orch.importDownload(1)).resolves.toEqual(mockResult);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        expect.stringContaining('Auto-merge enqueue failed'),
      );
    });

    it('a readdir failure during admission is swallowed — import unaffected, no enqueue', async () => {
      vi.mocked(readdir).mockRejectedValueOnce(new Error('EACCES'));
      const orch = withToggle(true);

      await expect(orch.importDownload(1)).resolves.toEqual(mockResult);
      expect(mergeService.enqueueMerge).not.toHaveBeenCalled();
    });

    it('no mergeService wired → auto-merge is a no-op (no crash, import succeeds)', async () => {
      const svc = createMockSettingsService({ processing: { autoMergeDownloads: true } });
      const orch = new ImportOrchestrator(importService, svc, log, notifier, tagging, eventHistory, broadcaster, inject<never>(connector), bookService);

      await expect(orch.importDownload(1)).resolves.toEqual(mockResult);
    });
  });

  describe('processCompletedDownloads — batch enqueue (#636)', () => {
    beforeEach(() => {
      vi.mocked(enqueueAutoImport).mockResolvedValue(true);
    });

    it('calls getEligibleDownloads and enqueues each as auto import job', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, bookId: 10 }, { id: 2, bookId: 20 },
      ]);

      const count = await orchestrator.processCompletedDownloads();

      expect(importService.getEligibleDownloads).toHaveBeenCalled();
      expect(enqueueAutoImport).toHaveBeenCalledTimes(2);
      expect(enqueueAutoImport).toHaveBeenCalledWith(expect.anything(), 1, 10, expect.any(Function), expect.anything());
      expect(enqueueAutoImport).toHaveBeenCalledWith(expect.anything(), 2, 20, expect.any(Function), expect.anything());
      expect(count).toBe(2);
    });

    it('returns 0 when no eligible downloads', async () => {
      const count = await orchestrator.processCompletedDownloads();
      expect(count).toBe(0);
    });

    it('continues enqueueing when one fails', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, bookId: 10 }, { id: 2, bookId: 20 },
      ]);
      vi.mocked(enqueueAutoImport)
        .mockRejectedValueOnce(new Error('db error'))
        .mockResolvedValueOnce(true);

      const count = await orchestrator.processCompletedDownloads();

      expect(count).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        expect.stringContaining('Failed to enqueue'),
      );
    });

    it('treats enqueue conflict as created=false (no warn, debug log, count not incremented) (#747)', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, bookId: 10 }, { id: 2, bookId: 20 }, { id: 3, bookId: 30 },
      ]);
      vi.mocked(enqueueAutoImport)
        .mockResolvedValueOnce(true)   // 1: created
        .mockResolvedValueOnce(false)  // 2: conflict
        .mockResolvedValueOnce(false); // 3: conflict

      const count = await orchestrator.processCompletedDownloads();

      expect(count).toBe(1);
      // The mocked helper bypasses its own info log, so only orchestrator debug logging is observable here.
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 2 }),
        expect.stringContaining('conflict'),
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 3 }),
        expect.stringContaining('conflict'),
      );
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('logs batch summary with total and enqueued count', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, bookId: 10 },
      ]);

      await orchestrator.processCompletedDownloads();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ total: 1, enqueued: 1 }),
        'Import batch enqueued',
      );
    });
  });

  describe('import failure blacklisting (#504)', () => {
    let blacklistService: BlacklistService;
    let retrySearchDeps: RetrySearchDeps;

    beforeEach(() => {
      blacklistService = inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) });
      retrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      // Wire this scope's spies instead of the parent fixture's defaults.
      orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster);
      orchestrator.wire({
        bookImportService: {} as never,
        blacklistService,
        retrySearchDeps,
        nudgeImportWorker: vi.fn(),
      });
    });

    it('content failure triggers blacklistAndRetrySearch with correct identifiers, reason, blacklistType, and retry-gating deps', async () => {
      const contentError = new ContentFailureError('Copy verification failed: source 1000 bytes, target 500 bytes');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        identifiers: expect.objectContaining({ infoHash: 'abc123', title: 'The Way of Kings [2010]', bookId: 1 }),
        reason: 'bad_quality',
        blacklistType: 'temporary',
        book: { id: 1 },
      }));

      const callArg = vi.mocked(blacklistAndRetrySearch).mock.calls[0]![0];
      expect(callArg.settingsService).toBe(settingsService);
      expect(callArg.retrySearchDeps).toBe(retrySearchDeps);
      expect(callArg).not.toHaveProperty('overrideRetry');
    });

    it('typed ContentFailureError with a reworded message still routes to bad_quality/temporary (#1304)', async () => {
      // Removing the legacy message substring proves classification uses instanceof.
      const typedError = new ContentFailureError('audio bytes mismatch after copy');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(typedError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'bad_quality',
        blacklistType: 'temporary',
      }));
    });

    it('guid-only usenet content failure propagates guid to blacklistAndRetrySearch', async () => {
      const usenetCtx = { ...mockContext, infoHash: null, guid: 'usenet-guid-abc' };
      (importService.getImportContext as ReturnType<typeof vi.fn>).mockResolvedValue(usenetCtx);
      const contentError = new ContentFailureError('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      const callArg = vi.mocked(blacklistAndRetrySearch).mock.calls[0]![0];
      expect(callArg.identifiers.guid).toBe('usenet-guid-abc');
      expect(callArg.identifiers.infoHash).toBeUndefined();
    });

    it('content failure (duplicate filename) triggers blacklistAndRetrySearch — original loop scenario', async () => {
      const dupeError = new ContentFailureError('Duplicate filename "01.mp3" found during import flattening: "/a" and "/b"');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(dupeError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'bad_quality',
        blacklistType: 'temporary',
      }));
    });

    it('environment failure does NOT call blacklistAndRetrySearch', async () => {
      const envError = new Error('Import blocked — insufficient disk space (1.0 GB free, 5.0 GB required)');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(envError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).not.toHaveBeenCalled();
    });

    it('environment failure (Audio processing failed) does NOT call blacklistAndRetrySearch', async () => {
      const procError = new Error('Audio processing failed: ffmpeg exited with code 1');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(procError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).not.toHaveBeenCalled();
    });

    it('blacklist call failure does not suppress original import error and logs warning', async () => {
      const blacklistError = new Error('DB blacklist error');
      vi.mocked(blacklistAndRetrySearch).mockRejectedValueOnce(blacklistError);
      const contentError = new ContentFailureError('Copy verification failed: source 1000 bytes, target 500 bytes');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toBe(contentError);

      // waitFor observes the asynchronous fire-and-forget rejection.
      await vi.waitFor(() => {
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: 'DB blacklist error', type: 'Error' }), downloadId: 1 }),
          'Import failure blacklist dispatch failed',
        );
      });
    });

    it('batch path: content failure blacklisting verified via importDownload (not processCompletedDownloads which now enqueues)', async () => {
      const contentError = new ContentFailureError('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledTimes(1);
    });
  });

  describe('required-wiring contract', () => {
    function makeUnwiredOrchestrator(): ImportOrchestrator {
      return new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster);
    }

    it('processCompletedDownloads() throws ServiceWireError when called before wire()', async () => {
      const unwired = makeUnwiredOrchestrator();
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 1, bookId: 10 }]);

      await expect(unwired.processCompletedDownloads()).rejects.toThrow(/ImportOrchestrator used before wire/);
    });

    it('importDownload() content-failure path throws ServiceWireError when called before wire()', async () => {
      const unwired = makeUnwiredOrchestrator();
      const contentError = new ContentFailureError('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      // Synchronous failure dispatch replaces the original content error with the wiring error.
      await expect(unwired.importDownload(1)).rejects.toThrow(/ImportOrchestrator used before wire/);
    });

    it('wire() called twice throws ServiceWireError', () => {
      const unwired = makeUnwiredOrchestrator();
      const wireDeps = {
        bookImportService: {} as never,
        blacklistService: inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) }),
        retrySearchDeps: { log: createMockLogger() } as unknown as RetrySearchDeps,
        nudgeImportWorker: vi.fn(),
      };
      unwired.wire(wireDeps);
      expect(() => unwired.wire(wireDeps)).toThrow(/ImportOrchestrator\.wire\(\) called more than once/);
    });
  });
});
