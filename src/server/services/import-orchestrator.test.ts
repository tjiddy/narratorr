import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImportOrchestrator, isContentFailure } from './import-orchestrator.js';
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

import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';

// Mock import-steps — we test the orchestrator's dispatch, not the helpers themselves
vi.mock('../utils/import-steps.js', () => ({
  emitDownloadImporting: vi.fn(),
  emitBookImporting: vi.fn(),
  emitImportSuccess: vi.fn(),
  emitImportFailure: vi.fn(),
  notifyImportComplete: vi.fn(),
  notifyImportFailure: vi.fn(),
  recordImportEvent: vi.fn(),
  recordImportFailedEvent: vi.fn(),
  embedTagsForImport: vi.fn().mockResolvedValue(undefined),
  runImportPostProcessing: vi.fn().mockResolvedValue(undefined),
}));

import {
  emitDownloadImporting, emitBookImporting, emitImportSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
  embedTagsForImport, runImportPostProcessing,
} from '../utils/import-steps.js';

function inject<T>(partial: Record<string, unknown>): T {
  return partial as T;
}

function createMockImportService(overrides?: Partial<Record<string, unknown>>): ImportService {
  return inject<ImportService>({
    importDownload: vi.fn(),
    getImportContext: vi.fn(),
    getEligibleDownloads: vi.fn().mockResolvedValue([]),
    tryAcquireSlot: vi.fn().mockReturnValue(true),
    releaseSlot: vi.fn(),
    setProcessingQueued: vi.fn(),
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
  });

  describe('importDownload — success path', () => {
    it('loads import context and calls importService.importDownload()', async () => {
      const result = await orchestrator.importDownload(1);

      expect(importService.getImportContext).toHaveBeenCalledWith(1);
      expect(importService.importDownload).toHaveBeenCalledWith(1);
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

    it('emits SSE import success after successful import', async () => {
      await orchestrator.importDownload(1);

      expect(emitImportSuccess).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 1, bookTitle: 'The Way of Kings',
      }));
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
        bookId: 1, bookTitle: 'The Way of Kings', downloadId: 1, error: importError,
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
      expect(emitImportSuccess).toHaveBeenCalled();
    });

    it('all fire-and-forget side effects dispatched even when best-effort fails', async () => {
      vi.mocked(embedTagsForImport).mockRejectedValueOnce(new Error('tag failed'));
      vi.mocked(runImportPostProcessing).mockRejectedValueOnce(new Error('script died'));

      await orchestrator.importDownload(1);

      // Fire-and-forget should still be called
      expect(emitImportSuccess).toHaveBeenCalled();
      expect(notifyImportComplete).toHaveBeenCalled();
      expect(recordImportEvent).toHaveBeenCalled();
    });
  });

  describe('processCompletedDownloads — batch loop', () => {
    it('calls importService.getEligibleDownloads() and iterates with importDownload per item', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1, 2]);
      const result2: ImportResult = { ...mockResult, downloadId: 2 };
      (importService.importDownload as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResult)
        .mockResolvedValueOnce(result2);

      const results = await orchestrator.processCompletedDownloads();

      expect(importService.getEligibleDownloads).toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('returns empty array when no eligible downloads', async () => {
      const results = await orchestrator.processCompletedDownloads();
      expect(results).toEqual([]);
    });

    it('collects results via Promise.allSettled — one failure does not block others', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1, 2]);
      (importService.importDownload as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('failed'))
        .mockResolvedValueOnce(mockResult);

      const results = await orchestrator.processCompletedDownloads();

      // Only the successful import should be in results
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(mockResult);
    });

    it('dispatches failure-path side effects for each failed download in batch', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1]);
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

      await orchestrator.processCompletedDownloads();

      // Failure side effects dispatched via orchestrator.importDownload catch
      expect(emitImportFailure).toHaveBeenCalled();
      expect(notifyImportFailure).toHaveBeenCalled();
      expect(recordImportFailedEvent).toHaveBeenCalled();
    });

    it('releases semaphore in .finally() even on throw', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1]);
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

      await orchestrator.processCompletedDownloads();

      expect(importService.releaseSlot).toHaveBeenCalledTimes(1);
    });
  });

  // ── #229 Observability — batch summary logging ──────────────────────────
  describe('batch summary logging (#229)', () => {
    it('logs { total, succeeded, failed, elapsedMs } at info after mixed results', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1, 2]);
      (importService.importDownload as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockResult)
        .mockRejectedValueOnce(new Error('fail'));

      await orchestrator.processCompletedDownloads();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ total: 2, succeeded: 1, failed: 1, elapsedMs: expect.any(Number) }),
        'Import batch completed',
      );
    });

    it('no summary log emitted when zero eligible downloads', async () => {
      await orchestrator.processCompletedDownloads();

      expect(log.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ total: expect.any(Number) }),
        'Import batch completed',
      );
    });

    it('all imports succeed: failed is 0', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1]);
      (importService.importDownload as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockResult);

      await orchestrator.processCompletedDownloads();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ total: 1, succeeded: 1, failed: 0, elapsedMs: expect.any(Number) }),
        'Import batch completed',
      );
    });

    it('all imports fail: succeeded is 0', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1]);
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

      await orchestrator.processCompletedDownloads();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ total: 1, succeeded: 0, failed: 1, elapsedMs: expect.any(Number) }),
        'Import batch completed',
      );
    });
  });

  // ── #504 — isContentFailure classifier ──────────────────────────────────
  describe('isContentFailure classifier (#504)', () => {
    describe('content failures — positive allowlist (returns true)', () => {
      it('returns true for "No audio files found in /path"', () => {
        expect(isContentFailure(new Error('No audio files found in /downloads/book'))).toBe(true);
      });

      it('returns true for "Source file is not a supported audio format: file.xyz"', () => {
        expect(isContentFailure(new Error('Source file is not a supported audio format: track.xyz'))).toBe(true);
      });

      it('returns true for "Duplicate filename found during import flattening"', () => {
        expect(isContentFailure(new Error('Duplicate filename "01.mp3" found during import flattening: "/a" and "/b"'))).toBe(true);
      });

      it('returns true for "Copy verification failed: source N bytes, target N bytes"', () => {
        expect(isContentFailure(new Error('Copy verification failed: source 1000 bytes, target 500 bytes'))).toBe(true);
      });
    });

    describe('environment failures — everything else (returns false)', () => {
      it('returns false for "Path not found: /path"', () => {
        expect(isContentFailure(new Error('Path not found: /downloads/book'))).toBe(false);
      });

      it('returns false for "Import blocked — insufficient disk space"', () => {
        expect(isContentFailure(new Error('Import blocked — insufficient disk space (1.0 GB free, 5.0 GB required)'))).toBe(false);
      });

      it('returns false for "Disk space check failed: permission denied"', () => {
        expect(isContentFailure(new Error('Disk space check failed: permission denied'))).toBe(false);
      });

      it('returns false for "Audio processing failed: ffmpeg exited with code 1"', () => {
        expect(isContentFailure(new Error('Audio processing failed: ffmpeg exited with code 1'))).toBe(false);
      });

      it('returns false for "Audio processing failed: ffmpeg stalled"', () => {
        expect(isContentFailure(new Error('Audio processing failed: ffmpeg stalled: no progress for 60s'))).toBe(false);
      });

      it('returns false for "Audio processing failed: spawn ENOENT"', () => {
        expect(isContentFailure(new Error('Audio processing failed: spawn ENOENT'))).toBe(false);
      });

      it('returns false for "Audio processing failed: Processing aborted"', () => {
        expect(isContentFailure(new Error('Audio processing failed: Processing aborted'))).toBe(false);
      });

      it('returns false for "Audio processing failed: some codec error"', () => {
        expect(isContentFailure(new Error('Audio processing failed: some codec error'))).toBe(false);
      });

      it('returns false for generic/unknown Error', () => {
        expect(isContentFailure(new Error('something unexpected'))).toBe(false);
      });

      it('returns false for non-Error throwable (string)', () => {
        expect(isContentFailure('a string error')).toBe(false);
      });
    });
  });

  // ── #504 — import failure blacklisting ──────────────────────────────────
  describe('import failure blacklisting (#504)', () => {
    let blacklistService: BlacklistService;
    let retrySearchDeps: RetrySearchDeps;

    beforeEach(() => {
      blacklistService = inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) });
      retrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      orchestrator.setBlacklistDeps(blacklistService, retrySearchDeps);
    });

    it('content failure triggers blacklistAndRetrySearch with correct identifiers, reason, and blacklistType', async () => {
      const contentError = new Error('Copy verification failed: source 1000 bytes, target 500 bytes');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        identifiers: expect.objectContaining({ infoHash: 'abc123', title: 'The Way of Kings [2010]', bookId: 1 }),
        reason: 'bad_quality',
        blacklistType: 'temporary',
        book: { id: 1 },
      }));
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

    it('content failure with missing blacklistService still fires SSE/notification/event', async () => {
      orchestrator.setBlacklistDeps(undefined as unknown as BlacklistService, retrySearchDeps);
      const contentError = new Error('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toThrow();

      // Blacklist not called (no service), but SSE/notification/event still fire
      expect(blacklistAndRetrySearch).not.toHaveBeenCalled();
      expect(emitImportFailure).toHaveBeenCalled();
      expect(notifyImportFailure).toHaveBeenCalled();
      expect(recordImportFailedEvent).toHaveBeenCalled();
    });

    it('blacklist call failure does not suppress original import error', async () => {
      vi.mocked(blacklistAndRetrySearch).mockRejectedValueOnce(new Error('DB blacklist error'));
      const contentError = new Error('Copy verification failed: source 1000 bytes, target 500 bytes');
      (importService.importDownload as ReturnType<typeof vi.fn>).mockRejectedValue(contentError);

      await expect(orchestrator.importDownload(1)).rejects.toBe(contentError);
    });

    it('batch path: content failure in one download blacklists it without affecting others', async () => {
      (importService.getEligibleDownloads as ReturnType<typeof vi.fn>).mockResolvedValue([1, 2]);
      const contentError = new Error('No audio files found in /path');
      (importService.importDownload as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(contentError)
        .mockResolvedValueOnce(mockResult);

      const results = await orchestrator.processCompletedDownloads();

      expect(results).toHaveLength(1);
      expect(blacklistAndRetrySearch).toHaveBeenCalledTimes(1);
    });
  });
});
