import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { QualityGateOrchestrator } from './quality-gate-orchestrator.js';
import type { QualityGateService, QualityDecision } from './quality-gate.service.js';
import { QualityGateServiceError, NULL_REASON } from './quality-gate.types.js';
import { inject, createMockDb, createMockLogger } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('../utils/download-path.js', () => ({
  resolveSavePath: vi.fn(),
}));

vi.mock('../utils/book-status.js', () => ({
  revertBookStatus: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('./retry-search.js', () => ({
  retrySearch: vi.fn(),
}));

import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { resolveSavePath } from '../utils/download-path.js';
import { revertBookStatus } from '../utils/book-status.js';
import { stat, rm } from 'node:fs/promises';
import { retrySearch } from './retry-search.js';
import type { SettingsService } from './settings.service.js';
import type { RetrySearchDeps } from './retry-search.js';

const mockAdapter = {
  removeDownload: vi.fn().mockResolvedValue(undefined),
};

function createOrchestrator(opts?: {
  retrySearchDeps?: RetrySearchDeps;
  settingsService?: SettingsService;
}) {
  const db = createMockDb();
  const log = createMockLogger();
  const eventHistory = { create: vi.fn().mockResolvedValue({}) };
  const broadcaster = { emit: vi.fn() };
  const blacklistService = { create: vi.fn().mockResolvedValue({}) };
  const downloadClientService = {
    getAdapter: vi.fn().mockResolvedValue(mockAdapter),
    getById: vi.fn().mockResolvedValue(null),
  };

  const qualityGateService = {
    getCompletedDownloads: vi.fn().mockResolvedValue([]),
    atomicClaim: vi.fn().mockResolvedValue(true),
    setStatus: vi.fn().mockResolvedValue(undefined),
    processDownload: vi.fn().mockResolvedValue({ action: 'imported', reason: { action: 'imported', holdReasons: [] }, statusTransition: { from: 'checking', to: 'completed' } }),
    approve: vi.fn().mockResolvedValue({ id: 1, status: 'importing', download: baseDownload, book: baseBook }),
    reject: vi.fn().mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook }),
    getDeferredCleanupCandidates: vi.fn().mockResolvedValue([]),
  };

  const orchestrator = new QualityGateOrchestrator(
    inject<QualityGateService>(qualityGateService),
    inject<Db>(db),
    inject<FastifyBaseLogger>(log),
    inject<DownloadClientService>(downloadClientService),
    inject<EventHistoryService>(eventHistory),
    inject<EventBroadcasterService>(broadcaster),
    inject<BlacklistService>(blacklistService),
    undefined, // remotePathMappingService
    opts?.retrySearchDeps ? inject<RetrySearchDeps>(opts.retrySearchDeps) : undefined,
    opts?.settingsService ? inject<SettingsService>(opts.settingsService) : undefined,
  );

  return { orchestrator, qualityGateService, db, log, eventHistory, broadcaster, blacklistService, downloadClientService };
}

const baseDownload = {
  id: 1, bookId: 1, title: 'Test Book', status: 'completed' as const,
  externalId: 'ext-1', downloadClientId: 1, infoHash: 'abc123',
  protocol: 'torrent' as const, downloadUrl: null, size: 500_000_000,
  seeders: 10, progress: 1, errorMessage: null, guid: null,
  outputPath: null, addedAt: new Date(), completedAt: new Date(),
  indexerId: 1, progressUpdatedAt: null, pendingCleanup: null,
};

const baseBook = {
  id: 1, title: 'Test Book', status: 'imported' as const,
  narrators: [{ name: 'John Smith' }], size: 400_000_000, duration: 600,
  audioTotalSize: null, audioDuration: 36000, path: '/library/test',
  asin: null, isbn: null, coverUrl: null, description: null,
  publishedDate: null, publisher: null, language: null,
  seriesName: null, seriesPosition: null, genres: null, tags: null,
  rating: null, ratingCount: null, pageCount: null,
  audioBitrate: null, audioCodec: null, audioSampleRate: null,
  audioChannels: null, updatedAt: new Date(), addedAt: new Date(),
  monitorForUpgrades: false, createdAt: new Date(), enrichmentStatus: 'pending' as const,
  audioBitrateMode: null, audioFileFormat: null, audioFileCount: null,
  audibleId: null, goodreadsId: null, seriesId: null, importListId: null,
};

const makeScan = () => ({
  totalSize: 600_000_000, totalDuration: 36000, channels: 1, codec: 'AAC',
  bitrate: 128000, sampleRate: 44100, bitrateMode: 'cbr' as const,
  fileFormat: 'm4b', fileCount: 1, hasCoverArt: false,
});

describe('QualityGateOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.removeDownload.mockResolvedValue(undefined);
    (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/test', originalPath: '/downloads/test' });
    (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan());
    (revertBookStatus as ReturnType<typeof vi.fn>).mockResolvedValue('imported');
  });

  describe('processCompletedDownloads', () => {
    it('calls service.getCompletedDownloads() and iterates over results', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.getCompletedDownloads).toHaveBeenCalled();
      expect(qualityGateService.atomicClaim).toHaveBeenCalledWith(1);
      expect(qualityGateService.processDownload).toHaveBeenCalled();
    });

    it('skips downloads without externalId', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([
        { download: { ...baseDownload, externalId: null }, book: baseBook },
      ]);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
    });

    it('skips downloads without bookId', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([
        { download: { ...baseDownload, bookId: null }, book: null },
      ]);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
    });

    it('skips silently when atomicClaim returns false', async () => {
      const { orchestrator, qualityGateService, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.atomicClaim.mockResolvedValue(false);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.processDownload).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.stringContaining('already claimed'));
    });

    it('continues to next download when one errors', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([
        { download: { ...baseDownload, id: 1 }, book: baseBook },
        { download: { ...baseDownload, id: 2 }, book: baseBook },
      ]);
      qualityGateService.processDownload
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ action: 'imported', reason: { action: 'imported', holdReasons: [] }, statusTransition: { from: 'checking', to: 'completed' } });

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.setStatus).toHaveBeenCalledWith(1, 'pending_review');
      expect(qualityGateService.processDownload).toHaveBeenCalledTimes(2);
    });
  });

  describe('probe failure handling', () => {
    it('sets pending_review via service.setStatus when resolveSavePath throws', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('path failed'));

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.setStatus).toHaveBeenCalledWith(1, 'pending_review');
      expect(qualityGateService.processDownload).not.toHaveBeenCalled();
    });

    it('sets pending_review via service.setStatus when scanAudioDirectory throws', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('scan failed'));

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.setStatus).toHaveBeenCalledWith(1, 'pending_review');
    });

    it('sets pending_review via service.setStatus when scanAudioDirectory returns null', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.setStatus).toHaveBeenCalledWith(1, 'pending_review');
    });

    it('calls processDownload (not setStatus pending_review) when resolved path is a single audio file', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/SingleBook.m4b', originalPath: '/downloads/SingleBook.m4b' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan());

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.processDownload).toHaveBeenCalledWith(baseDownload, baseBook, makeScan());
      expect(qualityGateService.setStatus).not.toHaveBeenCalledWith(1, 'pending_review');
    });

    it('emits SSE and records probeFailure event on probe failure', async () => {
      const { orchestrator, qualityGateService, broadcaster, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, old_status: 'checking', new_status: 'pending_review',
      }));
      expect(broadcaster.emit).toHaveBeenCalledWith('review_needed', expect.objectContaining({
        download_id: 1, book_id: 1, book_title: 'Test Book',
      }));
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ probeFailure: true, holdReasons: ['probe_failed'] }),
      }));
    });
  });

  describe('side effect dispatch — hold path', () => {
    it('emits download_status_change and review_needed SSE, records event', async () => {
      const { orchestrator, qualityGateService, broadcaster, eventHistory } = createOrchestrator();
      const holdDecision: QualityDecision = {
        action: 'held', reason: { action: 'held', mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false, existingNarrator: null, downloadNarrator: null, durationDelta: 0.05, existingDuration: 36000, downloadedDuration: 36000, codec: 'AAC', channels: 1, existingCodec: null, existingChannels: null, probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'] },
        statusTransition: { from: 'checking', to: 'pending_review' },
      };
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue(holdDecision);

      await orchestrator.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        old_status: 'checking', new_status: 'pending_review',
      }));
      expect(broadcaster.emit).toHaveBeenCalledWith('review_needed', expect.objectContaining({
        book_title: 'Test Book',
      }));
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ action: 'held' }),
      }));
    });

    it('skips SSE and event when book is null', async () => {
      const { orchestrator, qualityGateService, broadcaster, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([
        { download: { ...baseDownload, bookId: 1 }, book: null },
      ]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'held', reason: { action: 'held', mbPerHour: null, existingMbPerHour: null, narratorMatch: null, existingNarrator: null, downloadNarrator: null, durationDelta: null, existingDuration: null, downloadedDuration: null, codec: null, channels: null, existingCodec: null, existingChannels: null, probeFailure: false, probeError: null, holdReasons: ['no_quality_data'] },
        statusTransition: { from: 'checking', to: 'pending_review' },
      });

      await orchestrator.processCompletedDownloads();

      // SSE should NOT be emitted (no book)
      const statusChangeCalls = (broadcaster.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[0] === 'download_status_change' && (c[1] as { new_status: string }).new_status === 'pending_review');
      expect(statusChangeCalls).toHaveLength(0);
      // Event should not be recorded (no book)
      expect(eventHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('side effect dispatch — auto-import path', () => {
    it('emits download_status_change SSE but does NOT record any quality-gate event', async () => {
      const { orchestrator, qualityGateService, broadcaster, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'imported', reason: { action: 'imported', mbPerHour: 60, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'completed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        old_status: 'checking', new_status: 'completed',
      }));
      expect(eventHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('side effect dispatch — auto-reject path', () => {
    it('does NOT record any quality-gate event, blacklists when infoHash present, deletes files, reverts book', async () => {
      const { orchestrator, qualityGateService, eventHistory, blacklistService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({
        infoHash: 'abc123', reason: 'bad_quality',
      }));
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
      expect(revertBookStatus).toHaveBeenCalled();
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: 1,
      }));
    });

    it('emits download_status_change SSE with statusTransition.from (not stale download.status)', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      // download.status='completed' (from initial query), but statusTransition says checking→failed
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: { ...baseDownload, status: 'completed' }, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      // SSE should use 'checking' (from statusTransition), NOT 'completed' (from stale download.status)
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, old_status: 'checking', new_status: 'failed',
      }));
    });

    it('skips blacklist when infoHash absent', async () => {
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([
        { download: { ...baseDownload, infoHash: null }, book: baseBook },
      ]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(blacklistService.create).not.toHaveBeenCalled();
    });

    it('skips file deletion when adapter returns null', async () => {
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator();
      downloadClientService.getAdapter.mockResolvedValue(null);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('calls service.approve() and returns result with SSE but does NOT record quality-gate event', async () => {
      const { orchestrator, qualityGateService, broadcaster, eventHistory } = createOrchestrator();

      const result = await orchestrator.approve(1);

      expect(qualityGateService.approve).toHaveBeenCalledWith(1);
      expect(result).toEqual({ id: 1, status: 'importing' });
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, old_status: 'pending_review', new_status: 'importing',
      }));
      expect(eventHistory.create).not.toHaveBeenCalled();
    });

    it('skips SSE when bookId is null', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.approve.mockResolvedValue({ id: 1, status: 'importing', download: { ...baseDownload, bookId: null }, book: null });

      await orchestrator.approve(1);

      const statusChangeCalls = (broadcaster.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[0] === 'download_status_change');
      expect(statusChangeCalls).toHaveLength(0);
    });

    it('propagates QualityGateServiceError from service', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.approve.mockRejectedValue(new QualityGateServiceError('Download not found', 'NOT_FOUND'));

      await expect(orchestrator.approve(999)).rejects.toThrow(QualityGateServiceError);
    });
  });

  describe('reject', () => {
    it('calls service.reject() and returns result with cleanup but does NOT record quality-gate event', async () => {
      const { orchestrator, qualityGateService, eventHistory, blacklistService } = createOrchestrator();

      const result = await orchestrator.reject(1);

      expect(qualityGateService.reject).toHaveBeenCalledWith(1);
      expect(result).toEqual({ id: 1, status: 'failed' });
      expect(eventHistory.create).not.toHaveBeenCalled();
      // Default reject (no retry) skips blacklist (#301)
      expect(blacklistService.create).not.toHaveBeenCalled();
    });

    it('propagates QualityGateServiceError from service', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.reject.mockRejectedValue(new QualityGateServiceError('Download not found', 'NOT_FOUND'));

      await expect(orchestrator.reject(999)).rejects.toThrow(QualityGateServiceError);
    });
  });

  describe('fire-and-forget isolation', () => {
    it('event recording failure does not prevent SSE emission', async () => {
      const { orchestrator, qualityGateService, eventHistory, broadcaster } = createOrchestrator();
      eventHistory.create.mockRejectedValue(new Error('event DB error'));
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'held', reason: { action: 'held', mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false, existingNarrator: null, downloadNarrator: null, durationDelta: 0.05, existingDuration: 36000, downloadedDuration: 36000, codec: 'AAC', channels: 1, existingCodec: null, existingChannels: null, probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'] },
        statusTransition: { from: 'checking', to: 'pending_review' },
      });

      await orchestrator.processCompletedDownloads();

      // SSE should still have been emitted despite event failure
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.anything());
    });

    it('SSE failure does not prevent blacklist creation on reject', async () => {
      const { orchestrator, qualityGateService, broadcaster, blacklistService } = createOrchestrator();
      broadcaster.emit.mockImplementation(() => { throw new Error('SSE broken'); });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(blacklistService.create).toHaveBeenCalled();
    });

    it('blacklist failure does not prevent file deletion', async () => {
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator();
      blacklistService.create.mockRejectedValue(new Error('blacklist error'));
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalled();
    });

    it('file deletion failure does not prevent book status revert', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      mockAdapter.removeDownload.mockRejectedValue(new Error('delete error'));
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(revertBookStatus).toHaveBeenCalled();
    });

    it('revertBookStatus failure propagates in auto-reject (outer catch sets pending_review + unhandled_error)', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      (revertBookStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('revert failed'));
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      // The outer catch should have set pending_review
      expect(qualityGateService.setStatus).toHaveBeenCalledWith(1, 'pending_review');
      // And recorded an unhandled_error decision
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ probeFailure: true, holdReasons: ['unhandled_error'] }),
      }));
    });

    it('revertBookStatus failure propagates in manual reject (error thrown to caller)', async () => {
      const { orchestrator } = createOrchestrator();
      (revertBookStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('revert failed'));

      await expect(orchestrator.reject(1)).rejects.toThrow('revert failed');
    });
  });

  describe('probeError capture', () => {
    it('records probeError equal to error.message when resolveSavePath throws', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('path resolution failed'));

      await orchestrator.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ probeFailure: true, probeError: 'path resolution failed', holdReasons: ['probe_failed'] }),
      }));
    });

    it('records probeError equal to error.message when scanAudioDirectory throws', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ffprobe not found'));

      await orchestrator.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ probeFailure: true, probeError: 'ffprobe not found', holdReasons: ['probe_failed'] }),
      }));
    });

    it('records probeError string literal when scan result is null (no error object)', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ probeFailure: true, probeError: 'No audio files found', holdReasons: ['probe_failed'] }),
      }));
    });

    it('records probeError from unhandled catch error with holdReasons: [unhandled_error]', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      (revertBookStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unexpected DB failure'));
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.objectContaining({ probeFailure: true, probeError: 'unexpected DB failure', holdReasons: ['unhandled_error'] }),
      }));
    });

    it('NULL_REASON spreads include existingNarrator, downloadNarrator, probeError as null', () => {
      const spread = { ...NULL_REASON, probeFailure: true };
      expect(spread.existingNarrator).toBeNull();
      expect(spread.downloadNarrator).toBeNull();
      expect(spread.probeError).toBeNull();
    });
  });

  // ===== #248 — Reject cleanup: fallback file deletion =====

  describe('performRejectionCleanup — fallback file deletion', () => {
    it('deletes outputPath from disk when adapter removeDownload succeeds but files remain', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      const download = { ...baseDownload, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(stat).toHaveBeenCalledWith('/downloads/test-book');
      expect(rm).toHaveBeenCalledWith('/downloads/test-book', { recursive: true, force: true });
    });

    it('skips file deletion silently when outputPath is null', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      const download = { ...baseDownload, outputPath: null };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });

      await orchestrator.reject(1);

      expect(stat).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });

    it('skips file deletion silently when outputPath does not exist on disk', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      const download = { ...baseDownload, outputPath: '/downloads/missing' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

      await orchestrator.reject(1);

      expect(rm).not.toHaveBeenCalled();
    });

    it('logs at info level when fallback file deletion succeeds', async () => {
      const { orchestrator, qualityGateService, log } = createOrchestrator();
      const download = { ...baseDownload, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: '/downloads/test-book' }),
        expect.stringContaining('fallback deleted'),
      );
    });

    it('logs at debug level when outputPath is null or missing from disk', async () => {
      const { orchestrator, qualityGateService, log } = createOrchestrator();
      const download = { ...baseDownload, outputPath: '/downloads/missing' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

      await orchestrator.reject(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: '/downloads/missing' }),
        expect.stringContaining('does not exist'),
      );
    });

    it('still attempts direct file deletion when removeDownload throws', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      const download = { ...baseDownload, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      mockAdapter.removeDownload.mockRejectedValue(new Error('adapter error'));
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(rm).toHaveBeenCalledWith('/downloads/test-book', { recursive: true, force: true });
    });

    // #263: downloadRoot ancestry check removed — outputPath trust is ensured by resolveOutputPath hardening in monitor.ts

    it('skips adapter call when downloadClientId is null', async () => {
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator();
      const download = { ...baseDownload, downloadClientId: null, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

    it('skips adapter call when externalId is null', async () => {
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator();
      const download = { ...baseDownload, externalId: null, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });
  });

  // ===== #248 — Reject cleanup: blacklist with guid =====

  describe('performRejectionCleanup — GUID blacklisting', () => {
    it('blacklists by infoHash when present (retry=true)', async () => {
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator();
      const download = { ...baseDownload, infoHash: 'hash123', guid: 'guid456' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });

      await orchestrator.reject(1, { retry: true });

      expect(blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({
        infoHash: 'hash123',
        guid: 'guid456',
        reason: 'bad_quality',
      }));
    });

    it('blacklists by guid when infoHash is absent but guid is present (retry=true)', async () => {
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator();
      const download = { ...baseDownload, infoHash: null, guid: 'guid789' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });

      await orchestrator.reject(1, { retry: true });

      expect(blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({
        guid: 'guid789',
        reason: 'bad_quality',
      }));
    });

    it('skips blacklist and logs when neither infoHash nor guid is available (retry=true)', async () => {
      const { orchestrator, qualityGateService, blacklistService, log } = createOrchestrator();
      const download = { ...baseDownload, infoHash: null, guid: null };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });

      await orchestrator.reject(1, { retry: true });

      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('Blacklist skipped'),
      );
    });
  });

  // ===== #248 — Reject cleanup: fire-and-forget re-search =====

  describe('performRejectionCleanup — re-search on reject', () => {
    it('triggers retrySearch fire-and-forget when retry=true and redownloadFailed is true', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'retried' });

      await orchestrator.reject(1, { retry: true });

      // Fire-and-forget — flush microtasks
      await vi.waitFor(() => {
        expect(retrySearch).toHaveBeenCalledWith(baseBook.id, mockRetrySearchDeps);
      });
    });

    it('does not trigger re-search when retry=false even with redownloadFailed=true', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      // Flush microtasks
      await new Promise((r) => setTimeout(r, 0));

      expect(retrySearch).not.toHaveBeenCalled();
    });

    it('returns immediately without waiting for retrySearch to complete', async () => {
      let resolveRetry!: () => void;
      const retryPromise = new Promise<void>((r) => { resolveRetry = r; });
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockReturnValue(retryPromise);

      // reject() should return without waiting for retrySearch
      const result = await orchestrator.reject(1, { retry: true });
      expect(result).toEqual({ id: 1, status: 'failed' });

      // retrySearch should have been triggered but not yet resolved
      resolveRetry();
    });

    it('logs warn and does not propagate when retrySearch throws', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService, log } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('search failed'));

      // Should not throw
      const result = await orchestrator.reject(1, { retry: true });
      expect(result).toEqual({ id: 1, status: 'failed' });

      // Flush microtasks to let the .catch fire
      await vi.waitFor(() => {
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 1 }),
          expect.stringContaining('Re-search after reject failed'),
        );
      });
    });

    it('skips re-search when retry=true but RetrySearchDeps is not injected', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1, { retry: true });

      await new Promise((r) => setTimeout(r, 0));

      expect(retrySearch).not.toHaveBeenCalled();
    });

    it('does not trigger re-search when retry=true but book is null', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: null });

      await orchestrator.reject(1, { retry: true });

      await new Promise((r) => setTimeout(r, 0));

      expect(retrySearch).not.toHaveBeenCalled();
    });
  });

  // Regression coverage for shared helper extraction: existing tests above cover
  // blacklisting with bad_quality, download file deletion, re-search trigger, and
  // dispatchSideEffects auto-reject — all exercising the same code path through
  // blacklistAndRetrySearch() after extraction.

  // #301 — Split reject into dismiss (retry=false) vs reject-and-search (retry=true)
  describe('reject with retry flag (#301)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockAdapter.removeDownload.mockResolvedValue(undefined);
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
    });

    it('reject(id) without retry flag skips blacklistAndRetrySearch — no blacklist created, no retry search', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1);
      await new Promise((r) => setTimeout(r, 0));

      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(retrySearch).not.toHaveBeenCalled();
    });

    it('reject(id, { retry: false }) skips blacklistAndRetrySearch — no blacklist created, no retry search', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1, { retry: false });
      await new Promise((r) => setTimeout(r, 0));

      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(retrySearch).not.toHaveBeenCalled();
    });

    it('reject(id, { retry: true }) calls blacklistAndRetrySearch — blacklist created, retry search triggered', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'retried' });

      await orchestrator.reject(1, { retry: true });

      expect(blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({
        infoHash: baseDownload.infoHash,
        title: baseDownload.title,
        reason: 'bad_quality',
      }));
      await vi.waitFor(() => {
        expect(retrySearch).toHaveBeenCalledWith(baseBook.id, mockRetrySearchDeps);
      });
    });

    it('reject(id, { retry: true }) triggers retry search even when redownloadFailed is false (overrides setting)', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: false }) };
      const { orchestrator, qualityGateService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'retried' });

      await orchestrator.reject(1, { retry: true });

      await vi.waitFor(() => {
        expect(retrySearch).toHaveBeenCalledWith(baseBook.id, mockRetrySearchDeps);
      });
    });

    it('reject(id, { retry: false }) still cleans up download files from client', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      expect(mockAdapter.removeDownload).toHaveBeenCalled();
    });

    it('reject(id, { retry: false }) still reverts book status correctly', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      expect(revertBookStatus).toHaveBeenCalled();
    });

    it('reject(id, { retry: true }) still reverts book status correctly', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true }) };
      const { orchestrator, qualityGateService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'retried' });

      await orchestrator.reject(1, { retry: true });

      expect(revertBookStatus).toHaveBeenCalled();
    });

    it('reject(id, { retry: false }) with null bookId: cleanup succeeds, no book revert, no book_status_change SSE', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      const orphanDownload = { ...baseDownload, bookId: null };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: orphanDownload, book: null });

      await orchestrator.reject(1, { retry: false });

      expect(revertBookStatus).not.toHaveBeenCalled();
      expect(mockAdapter.removeDownload).toHaveBeenCalled();
      // No book_status_change SSE — only download_status_change if book is present
      const bookSSECalls = (broadcaster.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'book_status_change',
      );
      expect(bookSSECalls).toHaveLength(0);
    });

    it('reject(id, { retry: true }) with null infoHash+guid: blacklist skipped, retry search still triggered', async () => {
      const mockRetrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: false }) };
      const { orchestrator, qualityGateService, blacklistService } = createOrchestrator({
        retrySearchDeps: mockRetrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      });
      const noIdDownload = { ...baseDownload, infoHash: null, guid: null };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: noIdDownload, book: baseBook });
      (retrySearch as ReturnType<typeof vi.fn>).mockResolvedValue({ outcome: 'retried' });

      await orchestrator.reject(1, { retry: true });

      expect(blacklistService.create).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(retrySearch).toHaveBeenCalledWith(baseBook.id, mockRetrySearchDeps);
      });
    });

    it('reject(id, { retry: false }) — file delete failure logged as warning, does not prevent book revert', async () => {
      const { orchestrator, qualityGateService, log } = createOrchestrator();
      mockAdapter.removeDownload.mockRejectedValue(new Error('adapter delete failed'));
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      expect(log.warn).toHaveBeenCalled();
      expect(revertBookStatus).toHaveBeenCalled();
    });
  });

  // #299 — Rejection cleanup respects delete-after-import and deregisters from download client
  describe('rejection cleanup respects import settings (#299)', () => {
    const importSettings = { deleteAfterImport: true, minSeedTime: 60, minFreeSpaceGB: 5, redownloadFailed: true };
    const downloadWithOutput = { ...baseDownload, outputPath: '/downloads/test-book', completedAt: new Date(Date.now() - 7200_000) }; // 2h ago, well past 60min seed time

    function setupWithSettings(settings: typeof importSettings) {
      const settingsService = { get: vi.fn().mockResolvedValue(settings) };
      return createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
    }

    beforeEach(() => {
      vi.clearAllMocks();
      mockAdapter.removeDownload.mockResolvedValue(undefined);
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    it('auto-reject + deleteAfterImport=false → files preserved, no removeDownload call, warning logged, pendingCleanup NOT set', async () => {
      const { orchestrator, qualityGateService, log, db } = setupWithSettings({ ...importSettings, deleteAfterImport: false });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutput, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ downloadId: downloadWithOutput.id }), expect.stringContaining('deleteAfterImport'));
      // pendingCleanup NOT set — verify no DB update with pendingCleanup
      const dbUpdateCalls = (db.update as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCleanupUpdates = dbUpdateCalls.filter(() => {
        const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
        return setCalls.some((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      });
      expect(pendingCleanupUpdates).toHaveLength(0);
    });

    it('auto-reject + deleteAfterImport=true + seed time not met → files preserved, pendingCleanup set to current timestamp', async () => {
      const recentDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - 30_000) }; // 30s ago, well within 60min seed time
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: recentDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      // pendingCleanup should be set via DB update
      expect(db.update).toHaveBeenCalled();
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      expect(pendingCall).toBeDefined();
      expect((pendingCall![0] as Record<string, unknown>).pendingCleanup).toBeInstanceOf(Date);
    });

    it('auto-reject + deleteAfterImport=true + seed time met → files deleted AND torrent removed, pendingCleanup remains NULL', async () => {
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutput, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(downloadWithOutput.externalId, true);
    });

    it('auto-reject + usenet download + deleteAfterImport=true → files deleted AND download removed immediately', async () => {
      const usenetDownload = { ...downloadWithOutput, protocol: 'usenet' as const, completedAt: new Date(Date.now() - 30_000) }; // 30s ago — should still be immediate for usenet
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: usenetDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(usenetDownload.externalId, true);
    });

    it('manual reject (dismiss) + deleteAfterImport=false → files preserved, warning logged, pendingCleanup NOT set', async () => {
      const { orchestrator, qualityGateService, log } = setupWithSettings({ ...importSettings, deleteAfterImport: false });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: downloadWithOutput, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ downloadId: downloadWithOutput.id }), expect.stringContaining('deleteAfterImport'));
    });

    it('manual reject (dismiss) + deleteAfterImport=true → files deleted AND client deregistered', async () => {
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: downloadWithOutput, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(downloadWithOutput.externalId, true);
    });

    it('settingsService.get(import) throws → error logged, no deletion, no deregistration, no pendingCleanup marker', async () => {
      const settingsService = { get: vi.fn().mockRejectedValue(new Error('DB connection failed')) };
      const { orchestrator, qualityGateService, log } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: downloadWithOutput, book: baseBook });

      await orchestrator.reject(1, { retry: false });

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining('import settings'));
    });

    it('adapter.removeDownload() throws → error logged, does not crash cycle, download status still failed', async () => {
      mockAdapter.removeDownload.mockRejectedValue(new Error('adapter error'));
      const { orchestrator, qualityGateService, log } = setupWithSettings(importSettings);
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: downloadWithOutput, book: baseBook });

      // Should not throw
      await orchestrator.reject(1, { retry: false });

      expect(log.warn).toHaveBeenCalled();
      expect(revertBookStatus).toHaveBeenCalled();
    });

    it('multiple rejections in same cycle → each processed independently, one failure does not block others', async () => {
      const download2 = { ...downloadWithOutput, id: 2, externalId: 'ext-2' };
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([
        { download: downloadWithOutput, book: baseBook },
        { download: download2, book: { ...baseBook, id: 2 } },
      ]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });
      // First adapter call fails, second succeeds
      mockAdapter.removeDownload.mockRejectedValueOnce(new Error('first fails')).mockResolvedValueOnce(undefined);

      await orchestrator.processCompletedDownloads();

      // Both downloads were processed (atomicClaim called twice)
      expect(qualityGateService.atomicClaim).toHaveBeenCalledTimes(2);
    });

    // Boundary values
    it('minSeedTime=0 → no seed time enforced, immediate removal, pendingCleanup never set', async () => {
      const recentDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - 1_000) }; // 1s ago
      const { orchestrator, qualityGateService } = setupWithSettings({ ...importSettings, minSeedTime: 0 });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: recentDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(recentDownload.externalId, true);
    });

    it('completedAt exactly at seed time boundary → elapsed equals threshold so torrent IS removed (strictly less-than defers)', async () => {
      // completedAt exactly 60 minutes ago — elapsed == minSeedMs, NOT strictly less-than, so removed immediately
      const boundaryDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - 60 * 60_000) };
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: boundaryDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      // At exactly the boundary: elapsed === minSeedMs, which is NOT strictly less-than, so it SHOULD be removed
      // Spec says "strictly less-than" for the condition that defers. elapsed < minSeedMs defers. elapsed >= minSeedMs removes.
      // 60min elapsed, 60min threshold → elapsed is NOT < threshold → remove immediately
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(boundaryDownload.externalId, true);
    });

    it('completedAt one second past seed time boundary → torrent removed, pendingCleanup remains NULL', async () => {
      const pastBoundaryDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - (60 * 60_000 + 1_000)) }; // 60m + 1s ago
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: pastBoundaryDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(pastBoundaryDownload.externalId, true);
    });

    it('completedAt=null + deleteAfterImport=true → seed time check skipped, immediate removal', async () => {
      const noCompletedAt = { ...downloadWithOutput, completedAt: null };
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: noCompletedAt, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(noCompletedAt.externalId, true);
    });
  });

  describe('cleanupDeferredRejections (#299)', () => {
    const importSettings = { deleteAfterImport: true, minSeedTime: 60, minFreeSpaceGB: 5, redownloadFailed: true };
    const deferredDownload = {
      ...baseDownload, id: 10, status: 'failed' as const,
      outputPath: '/downloads/deferred-book',
      pendingCleanup: new Date(Date.now() - 3600_000), // marked 1h ago
      completedAt: new Date(Date.now() - 7200_000), // completed 2h ago — well past 60min seed time
    };

    function setupWithSettings(settings: typeof importSettings) {
      const settingsService = { get: vi.fn().mockResolvedValue(settings) };
      return createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
    }

    beforeEach(() => {
      vi.clearAllMocks();
      mockAdapter.removeDownload.mockResolvedValue(undefined);
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });

    it('finds download with pendingCleanup set + seed time elapsed → files deleted, client deregistered, pendingCleanup cleared, outputPath cleared', async () => {
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(deferredDownload.externalId, true);
      expect(rm).toHaveBeenCalledWith(deferredDownload.outputPath, { recursive: true, force: true });
      // Verify DB update clears pendingCleanup and outputPath
      expect(db.update).toHaveBeenCalled();
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && 'pendingCleanup' in payload && payload.pendingCleanup === null;
      });
      expect(clearCall).toBeDefined();
      expect((clearCall![0] as Record<string, unknown>).outputPath).toBeNull();
    });

    it('finds download with pendingCleanup set + seed time still not elapsed → skipped, pendingCleanup untouched', async () => {
      const recentDownload = { ...deferredDownload, completedAt: new Date(Date.now() - 30_000) }; // completed 30s ago
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([recentDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });

    it('downloads with pendingCleanup=NULL are NOT included in query — getDeferredCleanupCandidates handles this', async () => {
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([]);

      await orchestrator.cleanupDeferredRejections();

      expect(qualityGateService.getDeferredCleanupCandidates).toHaveBeenCalled();
      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

    it('no deferred downloads → no-op, no errors', async () => {
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([]);

      await expect(orchestrator.cleanupDeferredRejections()).resolves.not.toThrow();
    });

    it('adapter error on one download → logged, pendingCleanup NOT cleared, continues to next', async () => {
      const download2 = { ...deferredDownload, id: 11, externalId: 'ext-2' };
      const { orchestrator, qualityGateService, log } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload, download2]);
      mockAdapter.removeDownload
        .mockRejectedValueOnce(new Error('adapter fails'))
        .mockResolvedValueOnce(undefined);

      await orchestrator.cleanupDeferredRejections();

      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ downloadId: deferredDownload.id }), expect.any(String));
      // Second download should still be processed
      expect(mockAdapter.removeDownload).toHaveBeenCalledTimes(2);
    });

    it('file deletion succeeds but adapter error → pendingCleanup NOT cleared, outputPath cleared', async () => {
      mockAdapter.removeDownload.mockRejectedValue(new Error('adapter fails'));
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      // outputPath should be cleared (files are deleted by fallback), but pendingCleanup should NOT be cleared
      expect(rm).toHaveBeenCalledWith(deferredDownload.outputPath, { recursive: true, force: true });
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      // Should have an outputPath-clear call but NOT a pendingCleanup-clear call
      const outputPathClearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && 'outputPath' in payload && payload.outputPath === null && !('pendingCleanup' in payload && payload.pendingCleanup === null);
      });
      expect(outputPathClearCall).toBeDefined();
    });

    it('rm() fails (permissions/IO error) → pendingCleanup NOT cleared, outputPath NOT cleared, retry preserved', async () => {
      (rm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES: permission denied'));
      const { orchestrator, qualityGateService, db, log } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      // rm was attempted
      expect(rm).toHaveBeenCalledWith(deferredDownload.outputPath, { recursive: true, force: true });
      // File deletion failure logged as warning
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: deferredDownload.id, outputPath: deferredDownload.outputPath }),
        expect.stringContaining('file deletion failed'),
      );
      // Neither pendingCleanup nor outputPath should be cleared — full retry next cycle
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && ('pendingCleanup' in payload || 'outputPath' in payload);
      });
      expect(clearCall).toBeUndefined();
    });

    it('stat() fails (ENOENT) → files already gone, pendingCleanup cleared along with outputPath', async () => {
      const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(enoent);
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      // rm should NOT be called — files are already gone
      expect(rm).not.toHaveBeenCalled();
      // Both markers should be cleared
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearBothCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && 'pendingCleanup' in payload && payload.pendingCleanup === null && 'outputPath' in payload && payload.outputPath === null;
      });
      expect(clearBothCall).toBeDefined();
    });

    it('stat() fails with non-ENOENT error (permissions) → retry markers preserved', async () => {
      const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(eacces);
      const { orchestrator, qualityGateService, db, log } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(rm).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: deferredDownload.id, outputPath: deferredDownload.outputPath }),
        expect.stringContaining('stat failed'),
      );
      // Neither marker should be cleared — can't verify file state
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && ('pendingCleanup' in payload || 'outputPath' in payload);
      });
      expect(clearCall).toBeUndefined();
    });

    it('retry after prior adapter failure cleared outputPath → outputPath=null treated as files gone, pendingCleanup cleared', async () => {
      // Simulate cycle 2: adapter now succeeds, outputPath was already cleared in cycle 1
      const retryDownload = { ...deferredDownload, outputPath: null };
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([retryDownload]);

      await orchestrator.cleanupDeferredRejections();

      // Adapter should succeed (default mock), files are already gone (outputPath=null)
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(retryDownload.externalId, true);
      // pendingCleanup should now be cleared — the retry is complete
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && 'pendingCleanup' in payload && payload.pendingCleanup === null;
      });
      expect(clearCall).toBeDefined();
    });
  });

  // #300 — Persisted payload includes new existing audio metadata fields
  describe('persisted payload — existing audio metadata (#300)', () => {
    it('stored reason JSON includes existingCodec, existingChannels, existingDuration, downloadedDuration for held downloads with existing book metadata', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      const bookWithAudio = { ...baseBook, audioCodec: 'AAC', audioChannels: 2, audioDuration: 36000 };
      const holdDecision: QualityDecision = {
        action: 'held',
        reason: {
          action: 'held', mbPerHour: 60, existingMbPerHour: 40,
          narratorMatch: false, existingNarrator: null, downloadNarrator: null,
          durationDelta: 0.05, existingDuration: 36000, downloadedDuration: 36000,
          codec: 'AAC', channels: 2, existingCodec: 'AAC', existingChannels: 2,
          probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'],
        },
        statusTransition: { from: 'checking', to: 'pending_review' },
      };
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: bookWithAudio }]);
      qualityGateService.processDownload.mockResolvedValue(holdDecision);

      await orchestrator.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'held_for_review',
        reason: expect.objectContaining({
          existingCodec: 'AAC',
          existingChannels: 2,
          existingDuration: 36000,
          downloadedDuration: 36000,
        }),
      }));
    });
  });
});
