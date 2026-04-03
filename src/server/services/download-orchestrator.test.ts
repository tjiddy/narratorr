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
}));

// Mock book-status utility
vi.mock('../utils/book-status.js', () => ({
  revertBookStatus: vi.fn().mockResolvedValue('wanted'),
}));

import {
  emitGrabStarted, emitBookStatusChangeOnGrab, emitDownloadProgress,
  emitDownloadStatusChange, emitBookStatusChange, notifyGrab,
  recordGrabbedEvent, recordDownloadCompletedEvent,
} from '../utils/download-side-effects.js';
import { revertBookStatus } from '../utils/book-status.js';

function inject<T>(partial: Record<string, unknown>): T {
  return partial as T;
}

function createMockDownloadService(overrides?: Partial<Record<string, unknown>>): DownloadService {
  return inject<DownloadService>({
    grab: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    updateProgress: vi.fn(),
    updateStatus: vi.fn(),
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
      updateStatus: vi.fn().mockResolvedValue(undefined),
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
    mockDb = { update: vi.fn().mockReturnValue({ set: mockSet }) };
    orchestrator = new DownloadOrchestrator(downloadService, mockDb as never, log, notifier, eventHistory, broadcaster, blacklistService);
  });

  describe('grab', () => {
    it('calls downloadService.grab() and returns the result', async () => {
      const params = { downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 };
      const result = await orchestrator.grab(params);
      expect(downloadService.grab).toHaveBeenCalledWith(params);
      expect(result).toBe(mockDownload);
    });

    it('dispatches grab_started SSE after successful grab (bookId present)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(emitGrabStarted).toHaveBeenCalledWith(expect.objectContaining({
        broadcaster, downloadId: 1, bookId: 2, bookTitle: 'Test', releaseTitle: 'Test',
      }));
    });

    it('dispatches book_status_change SSE after successful grab (bookId present)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect(emitBookStatusChangeOnGrab).toHaveBeenCalledWith(expect.objectContaining({
        broadcaster, bookId: 2, isHandoff: false,
      }));
    });

    it('updates book status to downloading in DB after successful grab', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      expect((mockDb as Record<string, unknown>).update).toHaveBeenCalled();
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
      (downloadService.grab as ReturnType<typeof vi.fn>).mockRejectedValue(new DuplicateDownloadError('Book 2 already has an active download (id: 1)', 'ACTIVE_DOWNLOAD_EXISTS'));
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
      expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 2, path: null });
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

    it('does NOT record an event (cancel is event-free)', async () => {
      await orchestrator.cancel(1);
      expect(recordGrabbedEvent).not.toHaveBeenCalled();
      expect(recordDownloadCompletedEvent).not.toHaveBeenCalled();
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

    it('still returns true when blacklistService.create() throws', async () => {
      (blacklistService.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blacklist boom'));
      const result = await orchestrator.cancel(1);
      expect(result).toBe(true);
    });

    it('logs warning when blacklistService.create() throws', async () => {
      (blacklistService.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blacklist boom'));
      await orchestrator.cancel(1);
      expect(log.warn).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('blacklist'));
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

  describe('updateStatus', () => {
    it('calls downloadService.updateStatus() then emits download_status_change SSE using meta', async () => {
      await orchestrator.updateStatus(1, 'completed', { bookId: 2, oldStatus: 'downloading' });
      expect(downloadService.updateStatus).toHaveBeenCalledWith(1, 'completed', { bookId: 2, oldStatus: 'downloading' });
      expect(emitDownloadStatusChange).toHaveBeenCalledWith(expect.objectContaining({
        downloadId: 1, bookId: 2, oldStatus: 'downloading', newStatus: 'completed',
      }));
    });

    it('skips SSE when meta is missing or incomplete', async () => {
      await orchestrator.updateStatus(1, 'completed');
      expect(emitDownloadStatusChange).not.toHaveBeenCalled();
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

    it('passes replaceExisting: true through to downloadService.grab()', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2, replaceExisting: true });
      expect(downloadService.grab).toHaveBeenCalledWith(
        expect.objectContaining({ replaceExisting: true }),
      );
    });

    it('passes replaceExisting: false through to downloadService.grab()', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2, replaceExisting: false });
      expect(downloadService.grab).toHaveBeenCalledWith(
        expect.objectContaining({ replaceExisting: false }),
      );
    });

    it('omits replaceExisting when not provided (backward-compatible)', async () => {
      await orchestrator.grab({ downloadUrl: 'magnet:?xt=abc', title: 'Test', bookId: 2 });
      const callArg = (downloadService.grab as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
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
      const callArg = (downloadService.grab as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.guid).toBeUndefined();
    });
  });
});
