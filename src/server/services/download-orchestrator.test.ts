import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadService, DownloadWithBook } from './download.service.js';
import { DuplicateDownloadError } from './download.service.js';
import type { NotifierService } from './notifier.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { FastifyBaseLogger } from 'fastify';

// Mock side-effect helpers — we test orchestrator dispatch, not the helpers
vi.mock('../utils/download-side-effects.js', () => ({
  emitGrabStarted: vi.fn(),
  emitBookStatusChangeOnGrab: vi.fn(),
  emitDownloadProgress: vi.fn(),
  emitDownloadStatusChange: vi.fn(),
  emitBookStatusChange: vi.fn(),
  notifyGrab: vi.fn(),
  recordGrabbedEvent: vi.fn(),
  recordDownloadCompletedEvent: vi.fn(),
  recordDownloadFailedEvent: vi.fn(),
}));

// Mock book-status utility
vi.mock('../utils/book-status.js', () => ({
  revertBookStatus: vi.fn().mockResolvedValue('wanted'),
  transitionBookStatus: vi.fn().mockResolvedValue(true),
  guardedRevertBookStatus: vi.fn().mockResolvedValue({ landed: true, status: 'wanted' }),
}));

import {
  emitGrabStarted, emitBookStatusChangeOnGrab, emitDownloadProgress,
  emitDownloadStatusChange, emitBookStatusChange, notifyGrab,
  recordGrabbedEvent, recordDownloadCompletedEvent, recordDownloadFailedEvent,
} from '../utils/download-side-effects.js';
import { revertBookStatus, transitionBookStatus } from '../utils/book-status.js';
import { createMockDb, mockDbChain } from '../__tests__/helpers.js';
import { hasInFlightReplace, canonicalReleaseIdentity } from './book-admission.js';
import type { DownloadRow } from './types.js';

function inject<T>(partial: Record<string, unknown>): T {
  return partial as T;
}

function createMockDownloadService(overrides?: Partial<Record<string, unknown>>): DownloadService {
  return inject<DownloadService>({
    grab: vi.fn(),
    removeExternalItem: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    retry: vi.fn(),
    updateProgress: vi.fn(),
    setError: vi.fn(),
    getById: vi.fn(),
    getActiveByBookId: vi.fn(),
    ...overrides,
  });
}

const mockDownload: DownloadWithBook = {
  id: 1,
  bookId: 2,
  title: 'Test Book [2024]',
  status: 'downloading',
  progress: 0,
  protocol: 'torrent',
  downloadUrl: 'magnet:?xt=urn:btih:abc',
  externalId: 'ext-1',
  downloadClientId: 1,
  indexerId: 3,
  size: 500_000,
  seeders: 10,
  infoHash: 'abc',
  guid: 'guid-123',
  errorMessage: null,
  completedAt: null,
  addedAt: new Date(),
  progressUpdatedAt: null,
  pendingCleanup: null,
  book: { id: 2, title: 'Test Book', status: 'downloading', path: null } as DownloadWithBook['book'],
} as DownloadWithBook;

const handoffDownload: DownloadWithBook = {
  ...mockDownload,
  externalId: null,
  status: 'completed',
  progress: 1,
} as DownloadWithBook;

describe('DownloadOrchestrator', () => {
  let downloadService: DownloadService;
  let log: FastifyBaseLogger;
  let notifier: NotifierService;
  let eventHistory: EventHistoryService;
  let broadcaster: EventBroadcasterService;
  let blacklistService: BlacklistService;
  let orchestrator: DownloadOrchestrator;
  let mockDb: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    downloadService = createMockDownloadService({
      grab: vi.fn().mockResolvedValue(mockDownload),
      cancel: vi.fn().mockResolvedValue(true),
      retry: vi.fn().mockResolvedValue({ status: 'retried', download: mockDownload }),
      updateProgress: vi.fn().mockResolvedValue(undefined),
      setError: vi.fn().mockResolvedValue(undefined),
      getById: vi.fn().mockResolvedValue(mockDownload),
    });
    log = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    notifier = inject<NotifierService>({ notify: vi.fn().mockResolvedValue(undefined) });
    eventHistory = inject<EventHistoryService>({ create: vi.fn().mockResolvedValue(undefined) });
    broadcaster = inject<EventBroadcasterService>({ emit: vi.fn() });
    blacklistService = inject<BlacklistService>({ create: vi.fn().mockResolvedValue({ id: 99 }) });
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    // `select(...).from(...).where(...).limit(...)` — orchestrator uses this to
    // capture pre-grab `books.status` (#1144). Default fixture book.status is
    // 'imported' so existing tests keep the auto-upgrade-style replacement shape.
    const mockSelectChain = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ status: 'imported' }]),
        }),
      }),
    };
    mockDb = {
      update: vi.fn().mockReturnValue({ set: mockSet }),
      select: vi.fn().mockReturnValue(mockSelectChain),
    };
    orchestrator = new DownloadOrchestrator(downloadService, mockDb as never, log, notifier, eventHistory, broadcaster, blacklistService);
  });

  describe('grab', () => {
    it('calls downloadService.grab() and returns the result', async () => {
      const params = { downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 };
      const result = await orchestrator.grab(params);
      expect(downloadService.grab).toHaveBeenCalledWith(expect.objectContaining(params));
      expect(result).toBe(mockDownload);
    });

    it('dispatches grab_started SSE after successful grab (bookId present)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(emitGrabStarted).toHaveBeenCalledWith(expect.objectContaining({
        broadcaster, downloadId: 1, bookId: 2, bookTitle: 'Test', releaseTitle: 'Test',
      }));
    });

    it('dispatches book_status_change SSE after successful grab with the captured prior lifecycle as old_status', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      // Default fixture pre-grab status is 'imported' (auto-upgrade shape).
      expect(emitBookStatusChangeOnGrab).toHaveBeenCalledWith(expect.objectContaining({
        broadcaster, bookId: 2, isHandoff: false, oldStatus: 'imported',
      }));
    });

    it('transitions book status to downloading via the guarded helper after successful grab', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(transitionBookStatus).toHaveBeenCalledWith(mockDb, 2, { status: 'downloading' });
    });

    it('updates book status to missing for handoff client (externalId=null)', async () => {
      (downloadService.grab as ReturnType<typeof vi.fn>).mockResolvedValue(handoffDownload);
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(emitBookStatusChangeOnGrab).toHaveBeenCalledWith(expect.objectContaining({
        isHandoff: true,
      }));
    });

    it('dispatches notification on grab (fire-and-forget)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2, size: 500 });
      expect(notifyGrab).toHaveBeenCalledWith(expect.objectContaining({
        notifierService: notifier, title: 'Test', size: 500,
      }));
    });

    it('records grabbed event with source and reason metadata', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2, indexerId: 3, size: 500, protocol: 'torrent', source: 'auto' });
      expect(recordGrabbedEvent).toHaveBeenCalledWith(expect.objectContaining({
        eventHistory, bookId: 2, bookTitle: 'Test', downloadId: 1, source: 'auto',
        reason: { indexerId: 3, size: 500, protocol: 'torrent' },
      }));
    });

    it('preserves source=rss through to event recording', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2, source: 'rss' });
      expect(recordGrabbedEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'rss' }));
    });

    it('propagates DuplicateDownloadError unchanged to caller', async () => {
      (downloadService.grab as ReturnType<typeof vi.fn>).mockRejectedValue(new DuplicateDownloadError('Book 2 already has an active download (id: 1)', 'ACTIVE_DOWNLOAD_EXISTS', { active: { title: 'A Book', count: 1 } }));
      await expect(orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 }))
        .rejects.toThrow(DuplicateDownloadError);
      // No side effects should fire on error
      expect(emitGrabStarted).not.toHaveBeenCalled();
    });

    it('skips SSE/book-status/notification when bookId is undefined', async () => {
      const noBokDownload = { ...mockDownload, bookId: undefined };
      (downloadService.grab as ReturnType<typeof vi.fn>).mockResolvedValue(noBokDownload);
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test' });
      expect(emitGrabStarted).not.toHaveBeenCalled();
      expect(emitBookStatusChangeOnGrab).not.toHaveBeenCalled();
    });

    it('notification failure does not affect grab result', async () => {
      (notifyGrab as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('notify boom'); });
      const result = await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(result).toBe(mockDownload);
    });

    it('SSE failure does not affect grab result', async () => {
      (emitGrabStarted as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE boom'); });
      const result = await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(result).toBe(mockDownload);
    });

    it('event recording failure does not affect grab result', async () => {
      (recordGrabbedEvent as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('record boom'); });
      const result = await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(result).toBe(mockDownload);
    });

    // #1144 — capture pre-grab book.status as durable signal for quality gate
    describe('bookStatusAtGrab capture (#1144)', () => {
      function withBookStatus(status: string) {
        (mockDb as Record<string, unknown>).select = vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ status }]),
            }),
          }),
        });
      }

      it('reads books.status BEFORE downloadService.grab and passes it through as bookStatusAtGrab', async () => {
        withBookStatus('wanted');
        await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
        expect(downloadService.grab).toHaveBeenCalledWith(
          expect.objectContaining({ bookStatusAtGrab: 'wanted' }),
        );
      });

      it('captures imported as bookStatusAtGrab when the book is already imported (auto-upgrade flow)', async () => {
        withBookStatus('imported');
        await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
        expect(downloadService.grab).toHaveBeenCalledWith(
          expect.objectContaining({ bookStatusAtGrab: 'imported' }),
        );
      });

      it('passes bookStatusAtGrab=null when params.bookId is undefined (orphaned grab)', async () => {
        const noBokDownload = { ...mockDownload, bookId: undefined };
        (downloadService.grab as ReturnType<typeof vi.fn>).mockResolvedValue(noBokDownload);
        await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test' });
        expect(downloadService.grab).toHaveBeenCalledWith(
          expect.objectContaining({ bookStatusAtGrab: null }),
        );
        // No books lookup when bookId absent
        expect((mockDb as Record<string, unknown>).select).not.toHaveBeenCalled();
      });

      it('captures the pre-grab status BEFORE the orchestrator flips the book to downloading', async () => {
        // Capture call order — select (books.status) must happen before the guarded
        // transition that flips the book status.
        const callOrder: string[] = [];
        (mockDb as Record<string, unknown>).select = vi.fn().mockImplementation(() => {
          callOrder.push('select');
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ status: 'wanted' }]),
              }),
            }),
          };
        });
        (transitionBookStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
          callOrder.push('transition');
          return Promise.resolve(true);
        });

        await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });

        expect(callOrder.indexOf('select')).toBeLessThan(callOrder.indexOf('transition'));
      });
    });
  });

  describe('cancel', () => {
    it('prefetches download+book via getById, then calls downloadService.cancel()', async () => {
      await orchestrator.cancel(1);
      expect(downloadService.getById).toHaveBeenCalledWith(1);
      expect(downloadService.cancel).toHaveBeenCalledWith(1);
    });

    it('returns false when download not found (getById returns null)', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await orchestrator.cancel(1);
      expect(result).toBe(false);
      expect(downloadService.cancel).not.toHaveBeenCalled();
    });

    it('reverts book status via revertBookStatus when bookId present', async () => {
      await orchestrator.cancel(1);
      expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 2 }, null);
    });

    it('emits download_status_change SSE with old status from prefetched download, new status failed', async () => {
      await orchestrator.cancel(1);
      expect(emitDownloadStatusChange).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'failed',
      }));
    });

    it('emits book_status_change SSE with old book status from prefetched download.book', async () => {
      await orchestrator.cancel(1);
      expect(emitBookStatusChange).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 2, oldStatus: 'downloading', newStatus: 'wanted',
      }));
    });

    it('skips all SSE and book status revert when download has no bookId', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockDownload, bookId: null, book: undefined });
      await orchestrator.cancel(1);
      expect(revertBookStatus).not.toHaveBeenCalled();
      expect(emitBookStatusChange).not.toHaveBeenCalled();
      expect(emitDownloadStatusChange).not.toHaveBeenCalled();
    });

    it('records download_failed event with reason Cancelled by user when bookId present', async () => {
      await orchestrator.cancel(1);
      expect(recordDownloadFailedEvent).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, bookTitle: 'Test Book [2024]', errorMessage: 'Cancelled by user',
      }));
    });

    it('skips download_failed event recording when download has no bookId', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockDownload, bookId: null, book: undefined });
      await orchestrator.cancel(1);
      expect(recordDownloadFailedEvent).not.toHaveBeenCalled();
    });

    it('returns same boolean as downloadService.cancel()', async () => {
      const result = await orchestrator.cancel(1);
      expect(result).toBe(true);
    });

    // #315 — blacklist integration
    it('calls blacklistService.create() with correct identifiers, reason user_cancelled, and blacklistType permanent when infoHash present', async () => {
      await orchestrator.cancel(1);
      expect(blacklistService.create).toHaveBeenCalledWith({
        infoHash: 'abc',
        guid: 'guid-123',
        title: 'Test Book [2024]',
        bookId: 2,
        reason: 'user_cancelled',
        blacklistType: 'permanent',
      });
    });

    it('calls blacklistService.create() with guid only when infoHash is null', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockDownload, infoHash: null });
      await orchestrator.cancel(1);
      expect(blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({
        infoHash: null,
        guid: 'guid-123',
        reason: 'user_cancelled',
        blacklistType: 'permanent',
      }));
    });

    it('skips blacklist when both infoHash and guid are null and logs at info level', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockDownload, infoHash: null, guid: null });
      await orchestrator.cancel(1);
      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.stringContaining('Blacklist skipped'));
    });

    it('still runs revertBookStatus and SSE side effects when both identifiers are null', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockDownload, infoHash: null, guid: null });
      await orchestrator.cancel(1);
      expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 2 }, null);
      expect(emitBookStatusChange).toHaveBeenCalledWith(expect.objectContaining({ bookId: 2 }));
      expect(emitDownloadStatusChange).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 1, bookId: 2, newStatus: 'failed' }));
    });

    it('still returns true when blacklistService.create() throws', async () => {
      (blacklistService.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blacklist boom'));
      const result = await orchestrator.cancel(1);
      expect(result).toBe(true);
    });

    it('logs warning when blacklistService.create() throws', async () => {
      (blacklistService.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blacklist boom'));
      await orchestrator.cancel(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: 'Error' }) }),
        expect.stringContaining('blacklist'),
      );
    });

    it('still runs revertBookStatus and SSE side effects after blacklistService.create() rejects', async () => {
      (blacklistService.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blacklist boom'));
      await orchestrator.cancel(1);
      expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 2 }, null);
      expect(emitBookStatusChange).toHaveBeenCalledWith(expect.objectContaining({ bookId: 2 }));
      expect(emitDownloadStatusChange).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 1, bookId: 2, newStatus: 'failed' }));
    });

    it('does not call blacklistService.create() when download not found', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await orchestrator.cancel(1);
      expect(blacklistService.create).not.toHaveBeenCalled();
    });

    it('creates blacklist entry for orphaned download (no bookId) with available identifiers', async () => {
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockDownload, bookId: null, book: undefined });
      await orchestrator.cancel(1);
      expect(blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({
        infoHash: 'abc',
        guid: 'guid-123',
        reason: 'user_cancelled',
        blacklistType: 'permanent',
      }));
    });

    it('creates blacklist entry after downloadService.cancel() and before book status revert', async () => {
      const callOrder: string[] = [];
      (downloadService.cancel as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('cancel'); return true; });
      (blacklistService.create as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('blacklist'); return { id: 99 }; });
      (revertBookStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('revertBookStatus'); return 'wanted'; });
      await orchestrator.cancel(1);
      expect(callOrder).toEqual(['cancel', 'blacklist', 'revertBookStatus']);
    });
  });

  describe('retry', () => {
    it('delegates to downloadService.retry() and returns result', async () => {
      const result = await orchestrator.retry(1);
      expect(downloadService.retry).toHaveBeenCalledWith(1);
      expect(result).toEqual({ status: 'retried', download: mockDownload });
    });
  });

  describe('updateProgress', () => {
    it('calls downloadService.updateProgress() then dispatches download_progress SSE', async () => {
      await orchestrator.updateProgress(1, 0.5, 2);
      expect(downloadService.updateProgress).toHaveBeenCalledWith(1, 0.5, 2);
      expect(emitDownloadProgress).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, progress: 0.5,
      }));
    });

    it('emits download_progress SSE on every call when bookId present', async () => {
      await orchestrator.updateProgress(1, 0.5, 2);
      expect(emitDownloadProgress).toHaveBeenCalled();
    });

    it('emits download_status_change SSE when progress >= 1 (completion)', async () => {
      await orchestrator.updateProgress(1, 1.0, 2);
      expect(emitDownloadStatusChange).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'completed',
      }));
    });

    it('records download_completed event when progress >= 1', async () => {
      // Need to set up getById for the title lookup
      (downloadService.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockDownload);
      await orchestrator.updateProgress(1, 1.0, 2);
      expect(recordDownloadCompletedEvent).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2,
      }));
    });

    it('does not emit download_status_change or record event when progress < 1', async () => {
      await orchestrator.updateProgress(1, 0.5, 2);
      expect(emitDownloadStatusChange).not.toHaveBeenCalled();
      expect(recordDownloadCompletedEvent).not.toHaveBeenCalled();
    });

    it('skips SSE when bookId is not provided', async () => {
      await orchestrator.updateProgress(1, 0.5);
      expect(emitDownloadProgress).not.toHaveBeenCalled();
    });
  });

  describe('setError', () => {
    it('calls downloadService.setError() then emits download_status_change SSE using meta', async () => {
      await orchestrator.setError(1, 'Connection lost', { bookId: 2, oldStatus: 'downloading' });
      expect(downloadService.setError).toHaveBeenCalledWith(1, 'Connection lost', { bookId: 2, oldStatus: 'downloading' });
      expect(emitDownloadStatusChange).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'failed',
      }));
    });

    it('skips SSE when meta is missing or incomplete', async () => {
      await orchestrator.setError(1, 'Connection lost');
      expect(emitDownloadStatusChange).not.toHaveBeenCalled();
    });

    it('records download_failed event with error message in reason when meta.bookId present', async () => {
      await orchestrator.setError(1, 'Connection lost', { bookId: 2, oldStatus: 'downloading' });
      expect(recordDownloadFailedEvent).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, errorMessage: 'Connection lost',
      }));
    });

    it('skips download_failed event recording when meta is missing', async () => {
      await orchestrator.setError(1, 'Connection lost');
      expect(recordDownloadFailedEvent).not.toHaveBeenCalled();
    });

    it('still succeeds if download_failed event recording throws', async () => {
      (recordDownloadFailedEvent as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('event fail'); });
      // Should not throw
      await orchestrator.setError(1, 'Connection lost', { bookId: 2, oldStatus: 'downloading' });
      expect(downloadService.setError).toHaveBeenCalled();
    });
  });

  describe('fire-and-forget isolation', () => {
    it('notification failure does not prevent SSE broadcast', async () => {
      (notifyGrab as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('notify fail'); });
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      // SSE helpers should still have been called
      expect(emitGrabStarted).toHaveBeenCalled();
    });

    it('SSE failure does not prevent event recording', async () => {
      (emitGrabStarted as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(recordGrabbedEvent).toHaveBeenCalled();
    });

    it('all fire-and-forget errors logged at warn level', async () => {
      (emitGrabStarted as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('SSE fail'); });
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(log.warn).toHaveBeenCalled();
    });

    it('does not pass any replaceExisting field (removed in #1103)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      const callArg = (downloadService.grab as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.replaceExisting).toBeUndefined();
    });

    // ===== #248 — guid threading =====

    it('passes guid to downloadService.grab when provided', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2, guid: 'test-guid-123' });
      expect(downloadService.grab).toHaveBeenCalledWith(
        expect.objectContaining({ guid: 'test-guid-123' }),
      );
    });

    it('omits guid when not provided (backward compatible)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      const callArg = (downloadService.grab as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.guid).toBeUndefined();
    });
  });

  // ── #1857 orchestrator-level integration: real lock/single-flight/commit-boundary wiring ──
  const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function replaceableRow(over: Partial<DownloadRow> = {}): DownloadRow {
    return {
      id: 10, title: 'Old Grab', clientStatus: 'downloading', pipelineStage: 'idle',
      externalId: 'ext-old', downloadClientId: 1, bookId: 5, bookStatusAtGrab: 'wanted',
      infoHash: 'oldhash', guid: 'old-guid', addedAt: new Date('2026-01-01'), ...over,
    } as DownloadRow;
  }

  function makeReplaceOrch() {
    const db = createMockDb();
    const ds = createMockDownloadService({
      grab: vi.fn().mockResolvedValue(mockDownload),
      getById: vi.fn().mockResolvedValue(mockDownload),
      getActiveByBookId: vi.fn().mockResolvedValue([]),
    });
    const orch = new DownloadOrchestrator(ds, db as never, log, notifier, eventHistory, broadcaster, blacklistService);
    return { db, ds, orch };
  }

  describe('per-book admission lock wiring (F5/F17)', () => {
    it('serializes two concurrent same-book admissions through grabInternal (barrier)', async () => {
      let releaseFirst!: (v: unknown) => void;
      asMock(downloadService.grab)
        .mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }))
        .mockImplementationOnce(() => Promise.resolve(mockDownload));

      const p1 = orchestrator.grabInternal({ downloadUrl: 'm', title: 'A', bookId: 900 });
      const p2 = orchestrator.grabInternal({ downloadUrl: 'm', title: 'B', bookId: 900 });
      await flush();

      // The second admission is blocked behind the first — only one grab in flight.
      // If the lock were removed, both would fire immediately → count 2 here.
      expect(downloadService.grab).toHaveBeenCalledTimes(1);
      releaseFirst(mockDownload);
      await Promise.all([p1, p2]);
      expect(downloadService.grab).toHaveBeenCalledTimes(2);
    });

    it('grabForRetry rechecks IN-LOCK via hasGrabBlocker: skips the grab when the book already has a blocker', async () => {
      // #1861 — the in-lock recheck runs the consolidated blocker classification
      // (gatherBookBlockers → classifyBlockers) against the db, not getActiveByBookId.
      const replaceableRow = { id: 1, title: 'X', clientStatus: 'queued', pipelineStage: 'idle', externalId: 'e', addedAt: new Date() };
      (mockDb as Record<string, unknown>).select = vi.fn()
        .mockReturnValueOnce(mockDbChain([replaceableRow])) // downloads (blocker present)
        .mockReturnValueOnce(mockDbChain([]));              // importJobs
      const result = await orchestrator.grabForRetry({ downloadUrl: 'm', title: 'A', bookId: 901 });
      expect(result).toBe('already_active');
      expect(downloadService.grab).not.toHaveBeenCalled();
    });

    it('grabForRetry grabs when no grab blocker exists for the book', async () => {
      (mockDb as Record<string, unknown>).select = vi.fn()
        .mockReturnValueOnce(mockDbChain([])) // downloads (no blocker)
        .mockReturnValueOnce(mockDbChain([])) // importJobs (no auto job)
        .mockReturnValue(mockDbChain([{ status: 'wanted' }])); // books.status capture in grabWithinAdmissionLock
      const result = await orchestrator.grabForRetry({ downloadUrl: 'm', title: 'A', bookId: 902 });
      expect(result).toBe(mockDownload);
      expect(downloadService.grab).toHaveBeenCalled();
    });
  });

  describe('single-flight through grabWithReplace (F6)', () => {
    it('coalesces two concurrent IDENTICAL confirmed replaces into ONE admission', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([])); // clear book (gather empty) + null book-status capture
      const p = { downloadUrl: 'm', title: 'New', bookId: 810, replace: true, guid: 'same-id' };

      const [a, b] = await Promise.all([orch.grabInternal(p), orch.grabInternal(p)]);

      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1); // second joined the first's in-flight promise
      expect(a).toBe(mockDownload);
      expect(b).toBe(mockDownload);
    });

    it('DISTINCT-identity confirmed replaces do NOT coalesce (serialize → two admissions)', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      const base = { downloadUrl: 'm', title: 'New', bookId: 811, replace: true };

      await Promise.all([
        orch.grabInternal({ ...base, guid: 'g1' }),
        orch.grabInternal({ ...base, guid: 'g2' }),
      ]);

      expect(asMock(ds.grab)).toHaveBeenCalledTimes(2);
    });
  });

  describe('post-insert book-status commit boundary (F10)', () => {
    it('v1/auto path: a post-insert book-status failure PROPAGATES (grab rejects)', async () => {
      asMock(transitionBookStatus).mockRejectedValueOnce(new Error('db locked'));
      await expect(orchestrator.grab({ downloadUrl: 'm', title: 'A', bookId: 920 })).rejects.toThrow('db locked');
      // Insert succeeded (grab ran); only the post-insert status write threw — legacy propagates (F16).
      expect(downloadService.grab).toHaveBeenCalled();
    });

    it('internal replace path: PERSISTENT book-status failure → grab SUCCEEDS + no book_status_change SSE', async () => {
      const { db, orch } = makeReplaceOrch();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }])); // claim lands
      db.select.mockReturnValueOnce(mockDbChain([replaceableRow()])).mockReturnValue(mockDbChain([]));
      asMock(transitionBookStatus).mockRejectedValue(new Error('db locked')); // persistent

      const result = await orch.grabInternal({ downloadUrl: 'm', title: 'New', bookId: 930, replace: true, guid: 'g' });

      expect(result).toBe(mockDownload); // best-effort — grab still resolves
      expect(emitBookStatusChangeOnGrab).not.toHaveBeenCalled(); // truthful SSE: suppressed on failure (F29)
    });

    it('internal replace path: book-status write RETRY-SUCCESS → exactly one book_status_change SSE', async () => {
      const { db, orch } = makeReplaceOrch();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValueOnce(mockDbChain([replaceableRow()])).mockReturnValue(mockDbChain([]));
      asMock(transitionBookStatus).mockRejectedValueOnce(new Error('transient')).mockResolvedValue(true);

      const result = await orch.grabInternal({ downloadUrl: 'm', title: 'New', bookId: 931, replace: true, guid: 'g' });

      expect(result).toBe(mockDownload);
      expect(emitBookStatusChangeOnGrab).toHaveBeenCalledTimes(1); // exactly one truthful event
    });
  });

  // ── #1857 F18 — the FULL AC5 single-flight enumerated contracts ──
  describe('single-flight enumerated contracts (F18/AC5)', () => {
    it('terminal Blackhole winner: two identical confirmed replaces coalesce to ONE handoff (one client-add), both share it', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([])); // clear book
      asMock(ds.grab).mockResolvedValue(handoffDownload); // externalId null (terminal handoff)
      asMock(ds.getById).mockResolvedValue(handoffDownload);
      const p = { downloadUrl: 'm', title: 'BH', bookId: 850, replace: true, guid: 'bh-id' };

      const [a, b] = await Promise.all([orch.grabInternal(p), orch.grabInternal(p)]);

      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1); // exactly one row-insert / client-add
      expect(a).toBe(handoffDownload);
      expect(b).toBe(handoffDownload); // the waiter shares the one terminal handoff
    });

    it('no self-deadlock: a single confirmed replace acquires the book key ONCE and completes under a timeout', async () => {
      const { db, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      const result = await Promise.race([
        orch.grabInternal({ downloadUrl: 'm', title: 'Solo', bookId: 851, replace: true, guid: 'solo' }),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('self-deadlock timeout')), 1000)),
      ]);
      expect(result).toBe(mockDownload);
    });

    it('distinct sections do NOT overlap: two different-release confirmed replaces on one book serialize', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      let releaseFirst!: (v: unknown) => void;
      asMock(ds.grab)
        .mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }))
        .mockImplementationOnce(() => Promise.resolve(mockDownload));
      const p1 = orch.grabInternal({ downloadUrl: 'm', title: 'A', bookId: 852, replace: true, guid: 'a' });
      const p2 = orch.grabInternal({ downloadUrl: 'm', title: 'B', bookId: 852, replace: true, guid: 'b' });
      await flush();
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1); // second section has not entered its grab
      releaseFirst(mockDownload);
      await Promise.all([p1, p2]);
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(2);
    });

    it('A→B→A settled: a re-issued A after the first A settled runs a FRESH admission (no post-settlement coalescing)', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      const pA = { downloadUrl: 'm', title: 'A', bookId: 853, replace: true, guid: 'a' };
      await orch.grabInternal(pA); // A1 settles
      await orch.grabInternal({ downloadUrl: 'm', title: 'B', bookId: 853, replace: true, guid: 'b' }); // B
      await orch.grabInternal(pA); // A2 after A1 settled → fresh (entry evicted)
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(3); // no stale coalescing
    });

    it('A→B→A pending: A2 joins A1 while B is queued; A2 shares A1 outcome and B still runs', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      const a1dl = { ...mockDownload, id: 100 } as typeof mockDownload;
      const bdl = { ...mockDownload, id: 200 } as typeof mockDownload;
      let releaseA1!: (v: unknown) => void;
      asMock(ds.grab)
        .mockImplementationOnce(() => new Promise((r) => { releaseA1 = r; })) // A1 deferred
        .mockImplementationOnce(() => Promise.resolve(bdl));                   // B
      asMock(ds.getById).mockImplementation((id: number) => Promise.resolve(id === 200 ? bdl : a1dl));
      const pA = { downloadUrl: 'm', title: 'A', bookId: 854, replace: true, guid: 'a' };
      const pB = { downloadUrl: 'm', title: 'B', bookId: 854, replace: true, guid: 'b' };

      const a1 = orch.grabInternal(pA); // A1 starts, holds the book mutex
      const b = orch.grabInternal(pB);  // B queued behind on the book mutex
      await flush();
      const a2 = orch.grabInternal(pA); // A2 joins A1's still-pending promise
      await flush();
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1); // only A1 has grabbed; A2 coalesced, B queued

      releaseA1(a1dl);
      const [r1, r2] = await Promise.all([a1, a2]);
      await b;
      expect(r1.id).toBe(100);
      expect(r2.id).toBe(100); // A2 shared A1's outcome
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(2); // A1 + B ran; A2 did not add a third
    });
  });

  // ── #1857 F19 — shared admission mutex proven across EVERY book-scoped entry path ──
  describe('shared admission mutex across entry paths (F19/AC13/AC17)', () => {
    it('a confirmed replace and a concurrent legacy grab() (v1/RSS/search-pipeline representative) do NOT overlap', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      let releaseReplace!: (v: unknown) => void;
      asMock(ds.grab)
        .mockImplementationOnce(() => new Promise((r) => { releaseReplace = r; }))
        .mockImplementationOnce(() => Promise.resolve(mockDownload));
      const replace = orch.grabInternal({ downloadUrl: 'm', title: 'R', bookId: 860, replace: true, guid: 'r' });
      const legacy = orch.grab({ downloadUrl: 'm', title: 'L', bookId: 860 }); // the shared grab() path
      await flush();
      // Removing the lock from grab() would let legacy fire immediately → count 2 here.
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1);
      releaseReplace(mockDownload);
      await Promise.all([replace, legacy]);
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(2);
    });

    it('a confirmed replace and a concurrent grabForRetry on the same book do NOT overlap', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.select.mockReturnValue(mockDbChain([]));
      asMock(ds.getActiveByBookId).mockResolvedValue([]); // retry would proceed to grab
      let releaseReplace!: (v: unknown) => void;
      asMock(ds.grab)
        .mockImplementationOnce(() => new Promise((r) => { releaseReplace = r; }))
        .mockImplementationOnce(() => Promise.resolve(mockDownload));
      const replace = orch.grabInternal({ downloadUrl: 'm', title: 'R', bookId: 861, replace: true, guid: 'r' });
      const retry = orch.grabForRetry({ downloadUrl: 'm', title: 'Retry', bookId: 861 });
      await flush();
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1);
      releaseReplace(mockDownload);
      await Promise.all([replace, retry]);
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(2);
    });
  });

  // ── #1857 F21 — Blackhole post-insert commit boundary (AC14) ──
  describe('Blackhole post-insert commit boundary (F21/AC14)', () => {
    it('persistent status-write failure → grab SUCCEEDS, one handoff, concurrent waiter shares it, degraded logged, entry evicted on settle', async () => {
      const { db, ds, orch } = makeReplaceOrch();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }])); // claim lands (replaceable path → bestEffort book status)
      db.select.mockReturnValueOnce(mockDbChain([replaceableRow()])).mockReturnValue(mockDbChain([]));
      asMock(ds.grab).mockResolvedValue(handoffDownload); // terminal handoff winner
      asMock(ds.getById).mockResolvedValue(handoffDownload);
      asMock(transitionBookStatus).mockRejectedValue(new Error('db unwritable')); // every retry fails

      const p = { downloadUrl: 'm', title: 'BH', bookId: 870, replace: true, guid: 'bh' };
      const [a, b] = await Promise.all([orch.grabInternal(p), orch.grabInternal(p)]);

      expect(a).toBe(handoffDownload); // handoff already committed → grab still succeeds
      expect(b).toBe(handoffDownload); // concurrent waiter shares the ONE handoff
      expect(asMock(ds.grab)).toHaveBeenCalledTimes(1);
      expect(emitBookStatusChangeOnGrab).not.toHaveBeenCalled(); // no false SSE (F29)
      expect(log.warn).toHaveBeenCalled(); // operator-visible degraded state logged
      // Registry entry evicts on settle — a later re-grab is fresh (no post-settlement dedup, F36).
      expect(hasInFlightReplace(`870::${canonicalReleaseIdentity(p)}`)).toBe(false);
    });
  });
});
