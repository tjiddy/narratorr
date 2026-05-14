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

// Mock rejection-helpers for blacklist dispatch testing
vi.mock('../utils/rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));

// Mock enqueue helper for processCompletedDownloads testing
vi.mock('../utils/enqueue-auto-import.js', () => ({
  enqueueAutoImport: vi.fn().mockResolvedValue(true),
}));

import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';

import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';

// Mock import-steps — passthrough isContentFailure to real implementation, spy on the rest
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
  bookPath: null,
  authorName: 'Brandon Sanderson',
  narratorStr: 'Michael Kramer',
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

    orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster);

    // Default wire — most tests need wired deps. Tests that exercise the unwired
    // contract construct their own orchestrator and skip the wire() call.
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
      // Book SSE should still fire
      expect(emitBookImporting).toHaveBeenCalled();
    });

    it('dispatches tagging after successful import (best-effort)', async () => {
      await orchestrator.importDownload(1);

      expect(embedTagsForImport).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 1, targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
      }));
    });

    it('dispatches post-processing after tagging (best-effort)', async () => {
      await orchestrator.importDownload(1);

      expect(runImportPostProcessing).toHaveBeenCalledWith(expect.objectContaining({
        targetPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
        bookTitle: 'The Way of Kings',
      }));
    });

    it('emits SSE status transitions after successful import (no import_complete — owned by queue worker, #1108)', async () => {
      await orchestrator.importDownload(1);

      expect(emitImportStatusSuccess).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 1,
      }));
      // #1108 — bookTitle is no longer part of the status-success helper's contract.
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

    it('dispatches failure SSE when importService.importDownload throws', async () => {
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

    it('uses "imported" as reverted book status when book had a path (upgrade)', async () => {
      const upgradeCtx = { ...mockContext, bookPath: '/audiobooks/old/path' };
      (importService.getImportContext as ReturnType<typeof vi.fn>).mockResolvedValue(upgradeCtx);

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

      // Fire-and-forget should still be called
      expect(emitImportStatusSuccess).toHaveBeenCalled();
      expect(notifyImportComplete).toHaveBeenCalled();
      expect(recordImportEvent).toHaveBeenCalled();
    });
  });

  describe('processCompletedDownloads — batch enqueue (#636)', () => {
    beforeEach(() => {
      // Orchestrator is already wired in the parent beforeEach with default
      // db + nudgeImportWorker; just reset the enqueue mock for these cases.
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

      // Only the non-conflict count is reflected
      expect(count).toBe(1);
      // Conflicts logged at debug level — the underlying helper's "skipping" info
      // log fires only when enqueue actually returns conflict (mock here returns
      // the boolean directly, so we assert on the orchestrator's debug log only).
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 2 }),
        expect.stringContaining('conflict'),
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 3 }),
        expect.stringContaining('conflict'),
      );
      // No warn log fired because conflict is not a failure
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

  // ── #504 — import failure blacklisting ──────────────────────────────────
  describe('import failure blacklisting (#504)', () => {
    let blacklistService: BlacklistService;
    let retrySearchDeps: RetrySearchDeps;

    beforeEach(() => {
      blacklistService = inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) });
      retrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      // Re-construct + wire so this scope's blacklistService/retrySearchDeps
      // (the ones the assertions reference) are the wired instances.
      orchestrator = new ImportOrchestrator(importService, settingsService, log, notifier, tagging, eventHistory, broadcaster);
      orchestrator.wire({
        bookImportService: {} as never,
        blacklistService,
        retrySearchDeps,
        nudgeImportWorker: vi.fn(),
      });
    });

    it('content failure triggers blacklistAndRetrySearch with correct identifiers, reason, blacklistType, and retry-gating deps', async () => {
      const contentError = new Error('Copy verification failed: source 1000 bytes, target 500 bytes');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        identifiers: expect.objectContaining({ infoHash: 'abc123', title: 'The Way of Kings [2010]', bookId: 1 }),
        reason: 'bad_quality',
        blacklistType: 'temporary',
        book: { id: 1 },
      }));

      // F2: verify retry-gating contract — settingsService and retrySearchDeps present, no overrideRetry
      const callArg = vi.mocked(blacklistAndRetrySearch).mock.calls[0]![0];
      expect(callArg.settingsService).toBe(settingsService);
      expect(callArg.retrySearchDeps).toBe(retrySearchDeps);
      expect(callArg).not.toHaveProperty('overrideRetry');
    });

    it('guid-only usenet content failure propagates guid to blacklistAndRetrySearch', async () => {
      const usenetCtx = { ...mockContext, infoHash: null, guid: 'usenet-guid-abc' };
      (importService.getImportContext as ReturnType<typeof vi.fn>).mockResolvedValue(usenetCtx);
      const contentError = new Error('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      const callArg = vi.mocked(blacklistAndRetrySearch).mock.calls[0]![0];
      expect(callArg.identifiers.guid).toBe('usenet-guid-abc');
      expect(callArg.identifiers.infoHash).toBeUndefined();
    });

    it('content failure (duplicate filename) triggers blacklistAndRetrySearch — original loop scenario', async () => {
      const dupeError = new Error('Duplicate filename "01.mp3" found during import flattening: "/a" and "/b"');
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
      const contentError = new Error('Copy verification failed: source 1000 bytes, target 500 bytes');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toBe(contentError);

      // F4: verify the fire-and-forget failure is observable via log.warn
      await vi.waitFor(() => {
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: 'DB blacklist error', type: 'Error' }), downloadId: 1 }),
          'Import failure blacklist dispatch failed',
        );
      });
    });

    it('batch path: content failure blacklisting verified via importDownload (not processCompletedDownloads which now enqueues)', async () => {
      // processCompletedDownloads now enqueues jobs — blacklisting happens when the adapter runs importDownload
      const contentError = new Error('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledTimes(1);
    });
  });

  // ── #739 — required-wiring contract ────────────────────────────────────
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
      const contentError = new Error('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      // The throw happens inside dispatchFailureSideEffects; it replaces the
      // original error because the dispatch is synchronous in the catch handler.
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
