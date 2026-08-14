import { describe, it, expect, vi, beforeEach } from 'vitest';
const { ffmpegState } = vi.hoisted(() => ({ ffmpegState: { resolves: true } }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null) };
});

import type { FastifyBaseLogger } from 'fastify';
import { QualityGateOrchestrator, type QualityGateOrchestratorOptionalDeps } from './quality-gate-orchestrator.js';
import type { QualityGateService, QualityDecision } from './quality-gate.service.js';
import { QualityGateServiceError, NULL_REASON } from './quality-gate.types.js';
import { inject, createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { gatherBookBlockers, classifyBlockers } from './download-blockers.js';
import { runReplaceWorkflow, type ReplaceCtx } from './download-replace-workflow.js';
import type { DownloadRow } from './types.js';
import type { DownloadService as DownloadServiceType } from './download.service.js';
import type { Db } from '@db/index.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { ImportOrchestrator } from './import-orchestrator.js';
import type { ImportService } from './import.service.js';

vi.mock('../utils/enqueue-auto-import.js', () => ({
  enqueueAutoImport: vi.fn().mockResolvedValue(true),
}));

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('../utils/download-path.js', () => ({
  resolveSavePath: vi.fn(),
}));

vi.mock('../utils/book-status.js', () => ({
  revertBookStatus: vi.fn(),
  transitionBookStatus: vi.fn().mockResolvedValue(true),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('./retry-search.js', () => ({
  retrySearch: vi.fn(),
}));

import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { resolveSavePath } from '../utils/download-path.js';
import { revertBookStatus, transitionBookStatus } from '../utils/book-status.js';
import { stat, rm } from 'node:fs/promises';
import { retrySearch } from './retry-search.js';
import type { SettingsService } from './settings.service.js';
import type { RetrySearchDeps } from './retry-search.js';

const mockAdapter = {
  removeDownload: vi.fn().mockResolvedValue(undefined),
  getDownload: vi.fn().mockResolvedValue({ ratio: 0.2 }),
};

function createOrchestrator(opts?: {
  retrySearchDeps?: RetrySearchDeps;
  settingsService?: SettingsService;
  importOrchestrator?: Partial<ImportOrchestrator>;
  importService?: Partial<ImportService>;
  /** First direct select in the vanished-download path: does downloads.id still exist? */
  existsResult?: unknown[];
  /** Second direct select: the book title lookup that decides whether an event is FK-valid. */
  bookResult?: unknown[];
  bookError?: Error;
}) {
  const db = createMockDb();
  if (opts?.existsResult) {
    db.select.mockReturnValueOnce(mockDbChain(opts.existsResult));
    if (opts.bookError) db.select.mockReturnValueOnce(mockDbChain([], { error: opts.bookError }));
    else if (opts.bookResult) db.select.mockReturnValueOnce(mockDbChain(opts.bookResult));
  }
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
    getCompletedDownloadById: vi.fn().mockResolvedValue(null),
    atomicClaim: vi.fn().mockResolvedValue(true),
    hold: vi.fn().mockResolvedValue(undefined),
    processDownload: vi.fn().mockResolvedValue({ action: 'imported', reason: { action: 'imported', holdReasons: [] }, statusTransition: { from: 'checking', to: 'completed' } }),
    approve: vi.fn().mockResolvedValue({ id: 1, status: 'importing', download: baseDownload, book: baseBook }),
    reject: vi.fn().mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook }),
    getDeferredCleanupCandidates: vi.fn().mockResolvedValue([]),
  };

  const importOrchestrator = {
    importDownload: vi.fn().mockResolvedValue(null),
    drainQueuedImports: vi.fn().mockResolvedValue(undefined),
    ...opts?.importOrchestrator,
  };

  const importService = {
    tryAcquireSlot: vi.fn().mockReturnValue(true),
    releaseSlot: vi.fn(),
    setProcessingQueued: vi.fn().mockResolvedValue(undefined),
    ...opts?.importService,
  };

  const orchestrator = new QualityGateOrchestrator(
    inject<QualityGateService>(qualityGateService),
    inject<Db>(db),
    inject<FastifyBaseLogger>(log),
    inject<DownloadClientService>(downloadClientService),
    {
      eventHistory: inject<EventHistoryService>(eventHistory),
      broadcaster: inject<EventBroadcasterService>(broadcaster),
      blacklistService: inject<BlacklistService>(blacklistService),
      ...(opts?.retrySearchDeps && { retrySearchDeps: inject<RetrySearchDeps>(opts.retrySearchDeps) }),
      ...(opts?.settingsService && { settingsService: inject<SettingsService>(opts.settingsService) }),
    },
  );
  // Default fixtures are wired; required-wiring tests construct their own orchestrator.
  orchestrator.wire({ nudgeImportWorker: vi.fn(), bookImportService: {} as never });

  return { orchestrator, qualityGateService, db, log, eventHistory, broadcaster, blacklistService, downloadClientService, importOrchestrator, importService };
}

const baseDownload = {
  id: 1, bookId: 1, title: 'Test Book',
  clientStatus: 'completed' as const, pipelineStage: 'idle' as const,
  externalId: 'ext-1', downloadClientId: 1, infoHash: 'abc123',
  protocol: 'torrent' as const, downloadUrl: null, size: 500_000_000,
  seeders: 10, progress: 1, errorMessage: null, guid: null,
  outputPath: null, addedAt: new Date(), completedAt: new Date(),
  indexerId: 1, progressUpdatedAt: null, pendingCleanup: null,
  bookStatusAtGrab: 'imported' as const,
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
  createdAt: new Date(), enrichmentStatus: 'pending' as const,
  audioBitrateMode: null, audioFileFormat: null, audioFileCount: null,
  seriesId: null, importListId: null,
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

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(qualityGateService.processDownload).toHaveBeenCalledTimes(2);
    });
  });

  describe('probe failure handling', () => {
    it('sets pending_review via service.setStatus when resolveSavePath throws', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('path failed'));

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(qualityGateService.processDownload).not.toHaveBeenCalled();
    });

    it('sets pending_review via service.setStatus when scanAudioDirectory throws', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('scan failed'));

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
    });

    it('sets pending_review via service.setStatus when scanAudioDirectory returns null', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
    });

    it('calls processDownload (not setStatus pending_review) when resolved path is a single audio file', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/SingleBook.m4b', originalPath: '/downloads/SingleBook.m4b' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan());

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.processDownload).toHaveBeenCalledWith(baseDownload, baseBook, makeScan());
      expect(qualityGateService.hold).not.toHaveBeenCalledWith(1);
    });

    it('passes derived ffprobePath and diagnostic callbacks to scanAudioDirectory when ffmpegPath is configured', async () => {
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' }),
      });
      const { orchestrator, qualityGateService, log } = createOrchestrator({ settingsService });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledWith(
        '/downloads/test',
        { skipCover: true, ffprobePath: '/usr/bin/ffprobe', onWarn: expect.any(Function), onDebug: expect.any(Function), onFilesWithoutCodec: expect.any(Function) },
      );

      const options = vi.mocked(scanAudioDirectory).mock.calls[0]![1]!;
      options.onWarn!('warn-msg', { warnPayload: 1 });
      expect(log.warn).toHaveBeenCalledWith({ warnPayload: 1 }, 'warn-msg');
      options.onDebug!('debug-msg', { debugPayload: 2 });
      expect(log.debug).toHaveBeenCalledWith({ debugPayload: 2 }, 'debug-msg');
    });

    it('passes ffprobePath as undefined when ffmpeg is not detected', async () => {
      ffmpegState.resolves = false;
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledWith(
        '/downloads/test',
        { skipCover: true, ffprobePath: undefined, onWarn: expect.any(Function), onDebug: expect.any(Function), onFilesWithoutCodec: expect.any(Function) },
      );
      ffmpegState.resolves = true;
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

  describe('outputPath fallback (#1120)', () => {
    const downloadWithOutputPath = { ...baseDownload, outputPath: '/downloads/persisted-correct-path' };

    it('falls back to download.outputPath when first scan returns null and paths differ', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutputPath, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/stale-from-qb', originalPath: '/downloads/stale-from-qb' });
      const fallbackScan = makeScan();
      (scanAudioDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(fallbackScan);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenNthCalledWith(1, '/downloads/stale-from-qb', expect.any(Object));
      expect(scanAudioDirectory).toHaveBeenNthCalledWith(2, '/downloads/persisted-correct-path', expect.any(Object));
      expect(qualityGateService.processDownload).toHaveBeenCalledWith(downloadWithOutputPath, baseBook, fallbackScan);
      const probeFailureCalls = (eventHistory.create as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => {
          const arg = c[0] as { reason?: { probeFailure?: boolean } };
          return arg.reason?.probeFailure === true;
        });
      expect(probeFailureCalls).toHaveLength(0);
      expect(qualityGateService.hold).not.toHaveBeenCalledWith(1);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1, resolvedPath: '/downloads/stale-from-qb', outputPath: '/downloads/persisted-correct-path' }),
        expect.stringContaining('outputPath as scan fallback'),
      );
    });

    it('preserves probe_failed hold when outputPath is null (no fallback attempted)', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: { ...baseDownload, outputPath: null }, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/x', originalPath: '/downloads/x' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledTimes(1);
      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(qualityGateService.hold).toHaveBeenCalledTimes(1);
      expect(eventHistory.create).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: null, fallbackAttempted: false }),
        'Quality gate: no audio files found',
      );
    });

    it('preserves probe_failed hold when outputPath is empty string (no fallback attempted)', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: { ...baseDownload, outputPath: '' }, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/x', originalPath: '/downloads/x' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledTimes(1);
      expect(scanAudioDirectory).not.toHaveBeenCalledWith('', expect.any(Object));
      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(qualityGateService.hold).toHaveBeenCalledTimes(1);
      expect(eventHistory.create).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: '', fallbackAttempted: false }),
        'Quality gate: no audio files found',
      );
    });

    it('preserves probe_failed hold with fallbackAttempted: true when both scans return null', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutputPath, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/stale-from-qb', originalPath: '/downloads/orig' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledTimes(2);
      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(qualityGateService.hold).toHaveBeenCalledTimes(1);
      expect(eventHistory.create).toHaveBeenCalledTimes(1);
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: { ...NULL_REASON, probeFailure: true, probeError: 'No audio files found', holdReasons: ['probe_failed'] },
      }));
      expect(log.warn).toHaveBeenCalledWith(
        {
          downloadId: 1,
          externalId: 'ext-1',
          resolvedPath: '/downloads/stale-from-qb',
          originalPath: '/downloads/orig',
          outputPath: '/downloads/persisted-correct-path',
          fallbackAttempted: true,
          filesPresentNoCodec: false,
        },
        'Quality gate: no audio files found',
      );
    });

    it('does not double-scan when resolvedPath equals download.outputPath', async () => {
      const { orchestrator, qualityGateService, log } = createOrchestrator();
      const samePath = '/downloads/same-path';
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: { ...baseDownload, outputPath: samePath }, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: samePath, originalPath: samePath });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledTimes(1);
      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: samePath, fallbackAttempted: false }),
        'Quality gate: no audio files found',
      );
    });

    it('warn log emits the six diagnostic fields as structured context, persisted reason unchanged', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutputPath, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/resolved', originalPath: '/downloads/original' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await orchestrator.processCompletedDownloads();

      const warnCall = (log.warn as ReturnType<typeof vi.fn>).mock.calls
        .find((c: unknown[]) => c[1] === 'Quality gate: no audio files found');
      expect(warnCall).toBeDefined();
      const ctx = warnCall![0] as Record<string, unknown>;
      expect(ctx).toEqual({
        downloadId: 1,
        externalId: 'ext-1',
        resolvedPath: '/downloads/resolved',
        originalPath: '/downloads/original',
        outputPath: '/downloads/persisted-correct-path',
        fallbackAttempted: true,
        filesPresentNoCodec: false,
      });

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: { ...NULL_REASON, probeFailure: true, probeError: 'No audio files found', holdReasons: ['probe_failed'] },
      }));
    });

    it('catches fallback scan errors and proceeds with probe_failed hold + fallbackAttempted: true', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutputPath, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/stale-from-qb', originalPath: '/downloads/stale-from-qb' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

      await expect(orchestrator.processCompletedDownloads()).resolves.toBeUndefined();

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(qualityGateService.hold).toHaveBeenCalledTimes(1);
      expect(eventHistory.create).toHaveBeenCalledTimes(1);
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        reason: { ...NULL_REASON, probeFailure: true, probeError: 'No audio files found', holdReasons: ['probe_failed'] },
      }));
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1, outputPath: '/downloads/persisted-correct-path', error: expect.any(Object) }),
        expect.stringContaining('outputPath fallback scan failed'),
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ fallbackAttempted: true, outputPath: '/downloads/persisted-correct-path' }),
        'Quality gate: no audio files found',
      );
    });

    it('holds with the unreadable_codec reason (not "No audio files found") when files are present but the codec is unreadable (#1667)', async () => {
      const { orchestrator, qualityGateService, eventHistory, log } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockImplementation((_path: string, opts: { onFilesWithoutCodec?: () => void }) => {
        opts?.onFilesWithoutCodec?.();
        return Promise.resolve(null);
      });

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      const reason = (eventHistory.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].reason as { probeFailure: boolean; probeError: string; holdReasons: string[] };
      expect(reason.probeFailure).toBe(true);
      expect(reason.holdReasons).toEqual(['unreadable_codec']);
      expect(reason.probeError).not.toBe('No audio files found');
      expect(reason.probeError).toMatch(/codec/i);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filesPresentNoCodec: true }),
        'Quality gate: audio files present but codec unreadable',
      );
    });

    it('still holds with probe_failed when the directory is genuinely empty (onFilesWithoutCodec not fired)', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      const reason = (eventHistory.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].reason as { probeError: string; holdReasons: string[] };
      expect(reason.holdReasons).toEqual(['probe_failed']);
      expect(reason.probeError).toBe('No audio files found');
    });

    it('derives probe_failed when the primary fires onFilesWithoutCodec but the outputPath fallback scans empty — latch must not leak across attempts (#1677)', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutputPath, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/stale', originalPath: '/downloads/stale' });
      // clearAllMocks leaves once-queues intact; reset before sequencing primary and fallback scans.
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockReset();
      (scanAudioDirectory as ReturnType<typeof vi.fn>)
        // Primary: files present, no codec.
        .mockImplementationOnce((_path: string, opts: { onFilesWithoutCodec?: () => void }) => {
          opts?.onFilesWithoutCodec?.();
          return Promise.resolve(null);
        })
        // Fallback: empty.
        .mockResolvedValueOnce(null);

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledTimes(2);
      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      const reason = (eventHistory.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].reason as { holdReasons: string[]; probeError: string };
      expect(reason.holdReasons).toEqual(['probe_failed']);
      expect(reason.probeError).toBe('No audio files found');
    });

    it('derives unreadable_codec from the fallback attempt when the primary scans empty and the outputPath fallback finds files with no codec (#1677)', async () => {
      const { orchestrator, qualityGateService, eventHistory } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutputPath, book: baseBook }]);
      (resolveSavePath as ReturnType<typeof vi.fn>).mockResolvedValue({ resolvedPath: '/downloads/stale', originalPath: '/downloads/stale' });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockReset();
      (scanAudioDirectory as ReturnType<typeof vi.fn>)
        // Primary: empty.
        .mockResolvedValueOnce(null)
        // Fallback: files present, no codec.
        .mockImplementationOnce((_path: string, opts: { onFilesWithoutCodec?: () => void }) => {
          opts?.onFilesWithoutCodec?.();
          return Promise.resolve(null);
        });

      await orchestrator.processCompletedDownloads();

      expect(scanAudioDirectory).toHaveBeenCalledTimes(2);
      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      const reason = (eventHistory.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].reason as { holdReasons: string[]; probeError: string };
      expect(reason.holdReasons).toEqual(['unreadable_codec']);
      expect(reason.probeError).toMatch(/codec/i);
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

      const statusChangeCalls = (broadcaster.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[0] === 'download_status_change' && (c[1] as { new_status: string }).new_status === 'pending_review');
      expect(statusChangeCalls).toHaveLength(0);
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
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: { ...baseDownload, status: 'completed' }, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', mbPerHour: 40, existingMbPerHour: 40, narratorMatch: true, existingNarrator: null, downloadNarrator: null, durationDelta: 0, codec: 'AAC', channels: 1, probeFailure: false, probeError: null, holdReasons: [] },
        statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

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
      expect(result).toEqual({ id: 1, status: 'importing', bookId: 1 });
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
      // Default retry=false skips blacklisting (#301).
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

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
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
        expect.stringContaining('deleted output path'),
      );
    });

    it('logs at debug level when outputPath is null or missing from disk', async () => {
      const { orchestrator, qualityGateService, log } = createOrchestrator();
      const download = { ...baseDownload, outputPath: '/downloads/missing' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValue(enoent);

      await orchestrator.reject(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ outputPath: '/downloads/missing' }),
        expect.stringContaining('already gone'),
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

    // outputPath is trusted here because monitor.ts hardens resolveOutputPath; no duplicate ancestry check (#263).

    it('skips adapter call when downloadClientId is null', async () => {
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator();
      const download = { ...baseDownload, downloadClientId: null, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      // Missing client wiring must not skip fallback deletion (#1293 F2).
      expect(rm).toHaveBeenCalledWith('/downloads/test-book', { recursive: true, force: true });
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
      // Missing externalId must not skip fallback deletion (#1293 F2).
      expect(rm).toHaveBeenCalledWith('/downloads/test-book', { recursive: true, force: true });
    });

    it('runs fallback outputPath delete on the no-adapter proceed path (#1293 F2)', async () => {
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator();
      downloadClientService.getAdapter.mockResolvedValue(null);
      const download = { ...baseDownload, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download, book: baseBook });
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await orchestrator.reject(1);

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalledWith('/downloads/test-book', { recursive: true, force: true });
    });
  });

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

      // Flush microtasks so any detached retry can start.
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

      const result = await orchestrator.reject(1, { retry: true });
      expect(result).toEqual({ id: 1, status: 'failed' });

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

      const result = await orchestrator.reject(1, { retry: true });
      expect(result).toEqual({ id: 1, status: 'failed' });

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

  describe('rejection cleanup respects import settings (#299)', () => {
    const importSettings = { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true };
    const downloadWithOutput = { ...baseDownload, outputPath: '/downloads/test-book', completedAt: new Date(Date.now() - 7200_000) }; // 2h old; past 60m seed time.

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
      const dbUpdateCalls = (db.update as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCleanupUpdates = dbUpdateCalls.filter(() => {
        const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
        return setCalls.some((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      });
      expect(pendingCleanupUpdates).toHaveLength(0);
    });

    it('auto-reject + deleteAfterImport=true + seed time not met → files preserved, pendingCleanup set to current timestamp', async () => {
      const recentDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - 30_000) };
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: recentDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
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
      const usenetDownload = { ...downloadWithOutput, protocol: 'usenet' as const, completedAt: new Date(Date.now() - 30_000) };
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
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ message: 'DB connection failed', type: 'Error' }) }), expect.stringContaining('import settings'));
    });

    it('adapter.removeDownload() throws → error logged, does not crash cycle, download status still failed', async () => {
      mockAdapter.removeDownload.mockRejectedValue(new Error('adapter error'));
      const { orchestrator, qualityGateService, log } = setupWithSettings(importSettings);
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: downloadWithOutput, book: baseBook });

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
      mockAdapter.removeDownload.mockRejectedValueOnce(new Error('first fails')).mockResolvedValueOnce(undefined);

      await orchestrator.processCompletedDownloads();

      expect(qualityGateService.atomicClaim).toHaveBeenCalledTimes(2);
    });

    it('minSeedTime=0 → no seed time enforced, immediate removal, pendingCleanup never set', async () => {
      const recentDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - 1_000) };
      const { orchestrator, qualityGateService } = setupWithSettings({ ...importSettings, minSeedTime: 0 });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: recentDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(recentDownload.externalId, true);
    });

    it('completedAt exactly at seed time boundary → elapsed equals threshold so torrent IS removed (strictly less-than defers)', async () => {
      const boundaryDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - 60 * 60_000) };
      const { orchestrator, qualityGateService } = setupWithSettings(importSettings);
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: boundaryDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(boundaryDownload.externalId, true);
    });

    it('completedAt one second past seed time boundary → torrent removed, pendingCleanup remains NULL', async () => {
      const pastBoundaryDownload = { ...downloadWithOutput, completedAt: new Date(Date.now() - (60 * 60_000 + 1_000)) };
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
    const importSettings = { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true };
    const deferredDownload = {
      ...baseDownload, id: 10, status: 'failed' as const,
      outputPath: '/downloads/deferred-book',
      pendingCleanup: new Date(Date.now() - 3600_000), // Marked 1h ago.
      completedAt: new Date(Date.now() - 7200_000), // Completed 2h ago; seed time met.
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
      const recentDownload = { ...deferredDownload, completedAt: new Date(Date.now() - 30_000) };
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
      expect(mockAdapter.removeDownload).toHaveBeenCalledTimes(2);
    });

    it('file deletion succeeds but adapter error → pendingCleanup NOT cleared, outputPath cleared', async () => {
      mockAdapter.removeDownload.mockRejectedValue(new Error('adapter fails'));
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(rm).toHaveBeenCalledWith(deferredDownload.outputPath, { recursive: true, force: true });
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
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

      expect(rm).toHaveBeenCalledWith(deferredDownload.outputPath, { recursive: true, force: true });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: deferredDownload.id, outputPath: deferredDownload.outputPath }),
        expect.stringContaining('file deletion failed'),
      );
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

      expect(rm).not.toHaveBeenCalled();
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
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && ('pendingCleanup' in payload || 'outputPath' in payload);
      });
      expect(clearCall).toBeUndefined();
    });

    it('retry after prior adapter failure cleared outputPath → outputPath=null treated as files gone, pendingCleanup cleared', async () => {
      const retryDownload = { ...deferredDownload, outputPath: null };
      const { orchestrator, qualityGateService, db } = setupWithSettings(importSettings);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([retryDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(retryDownload.externalId, true);
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && 'pendingCleanup' in payload && payload.pendingCleanup === null;
      });
      expect(clearCall).toBeDefined();
    });

    it('null adapter on proceed path counts as adapter-success → both markers cleared after file delete (#1293 F3)', async () => {
      const { orchestrator, qualityGateService, db, downloadClientService } = setupWithSettings(importSettings);
      downloadClientService.getAdapter.mockResolvedValue(null);
      qualityGateService.getDeferredCleanupCandidates = vi.fn().mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalledWith(deferredDownload.outputPath, { recursive: true, force: true });
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const clearBothCall = setCalls.find((call: unknown[]) => {
        const payload = call[0] as Record<string, unknown>;
        return payload && payload.pendingCleanup === null && payload.outputPath === null;
      });
      expect(clearBothCall).toBeDefined();
    });
  });

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

  describe('seed ratio gating (rejection cleanup)', () => {
    const ratioSettings = { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 1.0, minFreeSpaceGB: 5, redownloadFailed: true };
    const downloadWithOutput = { ...baseDownload, outputPath: '/downloads/test-book', completedAt: new Date(Date.now() - 7200_000) };

    beforeEach(() => {
      vi.clearAllMocks();
      mockAdapter.removeDownload.mockResolvedValue(undefined);
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
    });

    it('auto-reject + minSeedRatio > 0 + ratio below threshold → pendingCleanup set (deferred)', async () => {
      const settingsService = { get: vi.fn().mockResolvedValue(ratioSettings) };
      const { orchestrator, qualityGateService, db, downloadClientService } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      (downloadClientService.getAdapter as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAdapter, getDownload: vi.fn().mockResolvedValue({ ratio: 0.3 }) });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutput, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      expect(pendingCall).toBeDefined();
    });

    it('auto-reject + minSeedRatio > 0 + ratio at/above threshold + seed time met → immediate cleanup', async () => {
      const settingsService = { get: vi.fn().mockResolvedValue(ratioSettings) };
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      (downloadClientService.getAdapter as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAdapter, getDownload: vi.fn().mockResolvedValue({ ratio: 1.5 }) });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: downloadWithOutput, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(rm).toHaveBeenCalled();
    });

    it('usenet rejection → ratio check skipped, immediate cleanup regardless of minSeedRatio', async () => {
      const usenetDownload = { ...downloadWithOutput, protocol: 'usenet' as const };
      const settingsService = { get: vi.fn().mockResolvedValue(ratioSettings) };
      const { orchestrator, qualityGateService, db } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: usenetDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processCompletedDownloads();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(usenetDownload.externalId, true);
      const setCalls = (db.update().set as ReturnType<typeof vi.fn>).mock.calls;
      const pendingCall = setCalls.find((call: unknown[]) => call[0] && typeof call[0] === 'object' && 'pendingCleanup' in (call[0] as Record<string, unknown>));
      expect(pendingCall).toBeUndefined();
    });
  });

  describe('seed ratio gating (deferred rejection cleanup)', () => {
    const ratioSettings = { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 1.0, minFreeSpaceGB: 5, redownloadFailed: true };
    const deferredDownload = { ...baseDownload, outputPath: '/downloads/test-book', completedAt: new Date(Date.now() - 7200_000), pendingCleanup: new Date() };

    beforeEach(() => {
      vi.clearAllMocks();
      mockAdapter.removeDownload.mockResolvedValue(undefined);
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
    });

    it('deferred download with ratio now met + seed time met → cleanup proceeds', async () => {
      const settingsService = { get: vi.fn().mockResolvedValue(ratioSettings) };
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      (downloadClientService.getAdapter as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAdapter, getDownload: vi.fn().mockResolvedValue({ ratio: 1.5 }) });
      qualityGateService.getDeferredCleanupCandidates.mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(deferredDownload.externalId, true);
      expect(rm).toHaveBeenCalled();
    });

    it('deferred download with ratio still below threshold → skipped, pendingCleanup untouched', async () => {
      const settingsService = { get: vi.fn().mockResolvedValue(ratioSettings) };
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      (downloadClientService.getAdapter as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAdapter, getDownload: vi.fn().mockResolvedValue({ ratio: 0.3 }) });
      qualityGateService.getDeferredCleanupCandidates.mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });

    it('deferred download with seed time met but ratio not met → skipped', async () => {
      const settingsService = { get: vi.fn().mockResolvedValue(ratioSettings) };
      const { orchestrator, qualityGateService, downloadClientService } = createOrchestrator({ settingsService: inject<SettingsService>(settingsService) });
      (downloadClientService.getAdapter as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAdapter, getDownload: vi.fn().mockResolvedValue({ ratio: 0.5 }) });
      qualityGateService.getDeferredCleanupCandidates.mockResolvedValue([deferredDownload]);

      await orchestrator.cleanupDeferredRejections();

      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });
  });

  describe('#324 — quality gate held revert book status', () => {
    it('when download held for pending_review (probe failure), book status reverted from importing to downloading via guarded helper', async () => {
      const importingBook = { ...baseBook, status: 'importing' as const };
      const { orchestrator, qualityGateService, db } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: importingBook, narrators: [] }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('probe failed'));
      (resolveSavePath as ReturnType<typeof vi.fn>).mockReturnValue('/path');

      await orchestrator.processCompletedDownloads();

      // The expected importing status prevents clobbering a concurrent writer.
      expect(transitionBookStatus).toHaveBeenCalledWith(db, 1, { status: 'downloading', expected: { status: 'importing' } });
    });

    it('when download held for pending_review, book_status_change SSE emitted with revert', async () => {
      const importingBook = { ...baseBook, status: 'importing' as const };
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: importingBook, narrators: [] }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('probe failed'));
      (resolveSavePath as ReturnType<typeof vi.fn>).mockReturnValue('/path');

      await orchestrator.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
        book_id: 1, old_status: 'importing', new_status: 'downloading',
      });
    });

    it('when download rejected, book status revert still works (existing behavior)', async () => {
      const importingBook = { ...baseBook, status: 'importing' as const };
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: importingBook, narrators: [] }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({ files: [{ path: '/f.mp3', size: 100 }], totalSize: 100 });
      (resolveSavePath as ReturnType<typeof vi.fn>).mockReturnValue('/path');
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON, qualityFloorFailed: true }, statusTransition: { from: 'checking', to: 'failed' },
      });
      (revertBookStatus as ReturnType<typeof vi.fn>).mockResolvedValue('wanted');

      await orchestrator.processCompletedDownloads();

      expect(revertBookStatus).toHaveBeenCalled();
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: 1, new_status: 'wanted',
      }));
    });

    it('does NOT revert book status when book is not importing (guard condition)', async () => {
      const downloadingBook = { ...baseBook, status: 'downloading' as const };
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: downloadingBook, narrators: [] }]);
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('probe failed'));
      (resolveSavePath as ReturnType<typeof vi.fn>).mockReturnValue('/path');

      await orchestrator.processCompletedDownloads();

      expect(broadcaster.emit).not.toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        old_status: 'downloading', new_status: 'downloading',
      }));
    });
  });

  describe('processOneDownload', () => {
    const completedDownload = { ...baseDownload, status: 'completed' as const, bookId: 1 };
    const downloadingBook = { ...baseBook, status: 'downloading' as const };

    it('import job picks up completed downloads and runs import flow', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });

      await orchestrator.processOneDownload(1);

      expect(qualityGateService.getCompletedDownloadById).toHaveBeenCalledWith(1);
      expect(qualityGateService.atomicClaim).toHaveBeenCalledWith(1);
      expect(enqueueAutoImport).toHaveBeenCalledWith(
        expect.anything(), 1, 1, expect.any(Function), expect.anything(),
      );
    });

    it('treats enqueueAutoImport=false as a benign idempotency outcome (#747 F2)', async () => {
      // A false enqueue means another path won; it must not enter the outer error path or hold the download (#747 F2).
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });
      // The default imported decision reaches enqueue; false simulates the benign conflict.
      vi.mocked(enqueueAutoImport).mockResolvedValueOnce(false);

      await expect(orchestrator.processOneDownload(1)).resolves.toBeUndefined();

      expect(enqueueAutoImport).toHaveBeenCalledWith(
        expect.anything(), 1, 1, expect.any(Function), expect.anything(),
      );
      expect(qualityGateService.hold).not.toHaveBeenCalledWith(
        expect.anything(),
      );
    });

    it('holds for review and reverts book status to downloading', async () => {
      const { orchestrator, qualityGateService, db, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });
      qualityGateService.processDownload.mockResolvedValue({
        action: 'held', reason: { action: 'held', holdReasons: ['low_bitrate'] }, statusTransition: { from: 'checking', to: 'pending_review' },
      });

      await orchestrator.processOneDownload(1);

      expect(transitionBookStatus).toHaveBeenCalledWith(db, 1, { status: 'importing' });
      expect(transitionBookStatus).toHaveBeenCalledWith(db, 1, { status: 'downloading', expected: { status: 'importing' } });
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: 1, old_status: 'importing', new_status: 'downloading',
      }));
    });

    it('rejects and reverts book status to downloading', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { action: 'rejected', holdReasons: [] }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await orchestrator.processOneDownload(1);

      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        old_status: 'importing',
      }));
    });

    it('returns early when atomic claim fails (double-process guard)', async () => {
      const { orchestrator, qualityGateService, importOrchestrator } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });
      qualityGateService.atomicClaim.mockResolvedValue(false);

      await orchestrator.processOneDownload(1);

      expect(qualityGateService.processDownload).not.toHaveBeenCalled();
      expect(importOrchestrator.importDownload).not.toHaveBeenCalled();
    });

    it('promotes book status to importing via the guarded helper after atomic claim', async () => {
      const { orchestrator, qualityGateService, db } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });

      await orchestrator.processOneDownload(1);

      expect(transitionBookStatus).toHaveBeenCalledWith(db, 1, { status: 'importing' });
    });

    it('emits book_status_change SSE after promoting book', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });

      await orchestrator.processOneDownload(1);

      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: 1, old_status: 'downloading', new_status: 'importing',
      }));
    });

    it('updates in-memory book status so revert guards fire correctly', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      const bookCopy = { ...downloadingBook };
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: bookCopy });
      qualityGateService.processDownload.mockResolvedValue({
        action: 'held', reason: { action: 'held', holdReasons: ['low_bitrate'] }, statusTransition: { from: 'checking', to: 'pending_review' },
      });

      await orchestrator.processOneDownload(1);

      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        old_status: 'importing', new_status: 'downloading',
      }));
    });

    it('returns early for non-existent download', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      await orchestrator.processOneDownload(999);

      expect(qualityGateService.getCompletedDownloadById).toHaveBeenCalledWith(999);
      expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
    });

    // getCompletedDownloadById returns null for a vanished row AND for a benign not-yet/no-longer
    // completed one. Collapsing them is what made download 113 unattributable (#2307).
    describe('unavailable download — vanished row vs benign race', () => {
      it('row still present but no longer completed: warns, records nothing, claims nothing', async () => {
        const { orchestrator, qualityGateService, log, eventHistory } = createOrchestrator({
          existsResult: [{ id: 1 }],
        });

        await orchestrator.processOneDownload(1, { bookId: 5, releaseTitle: 'The Stranger [2026]' });

        expect(log.warn).toHaveBeenCalledWith({ downloadId: 1 }, expect.stringContaining('not found or not completed'));
        expect(log.error).not.toHaveBeenCalled();
        expect(eventHistory.create).not.toHaveBeenCalled();
        expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
      });

      it('row gone with a live book: errors with the book title and records one download_failed event', async () => {
        const { orchestrator, log, eventHistory } = createOrchestrator({
          existsResult: [],
          bookResult: [{ title: 'The Stranger' }],
        });

        await orchestrator.processOneDownload(113, { bookId: 5, releaseTitle: 'The Stranger [2026] [MP3]' });

        expect(log.error).toHaveBeenCalledWith(
          { downloadId: 113, bookId: 5, bookTitle: 'The Stranger' },
          expect.stringContaining('disappeared before the quality gate'),
        );
        expect(eventHistory.create).toHaveBeenCalledTimes(1);
        expect(eventHistory.create).toHaveBeenCalledWith({
          bookId: 5,
          bookTitle: 'The Stranger',
          // The book's own title, never the polled release title.
          downloadId: null,
          eventType: 'download_failed',
          source: 'auto',
          reason: { error: 'Download row disappeared before the quality gate could evaluate it' },
        });
        expect(log.warn).not.toHaveBeenCalled();
      });

      it('row gone with a null book id: errors with the release title and records no event', async () => {
        const { orchestrator, log, eventHistory } = createOrchestrator({ existsResult: [] });

        await orchestrator.processOneDownload(113, { bookId: null, releaseTitle: 'The Stranger [2026]' });

        expect(log.error).toHaveBeenCalledWith(
          { downloadId: 113, releaseTitle: 'The Stranger [2026]' },
          expect.stringContaining('disappeared before the quality gate'),
        );
        expect(eventHistory.create).not.toHaveBeenCalled();
      });

      it('row gone with no provenance at all: errors on the download id alone', async () => {
        const { orchestrator, log, eventHistory } = createOrchestrator({ existsResult: [] });

        await orchestrator.processOneDownload(113);

        expect(log.error).toHaveBeenCalledWith(
          { downloadId: 113 },
          expect.stringContaining('disappeared before the quality gate'),
        );
        expect(eventHistory.create).not.toHaveBeenCalled();
      });

      it('row gone but the book was concurrently deleted: no event, and bookDeleted is explicit', async () => {
        const { orchestrator, log, eventHistory } = createOrchestrator({ existsResult: [], bookResult: [] });

        await orchestrator.processOneDownload(113, { bookId: 5, releaseTitle: 'The Stranger [2026]' });

        expect(log.error).toHaveBeenCalledWith(
          { downloadId: 113, bookId: 5, releaseTitle: 'The Stranger [2026]', bookDeleted: true },
          expect.stringContaining('disappeared before the quality gate'),
        );
        // An FK-rejected insert would be swallowed and look identical to this deliberate skip.
        expect(eventHistory.create).not.toHaveBeenCalled();
      });

      it('row gone and the book lookup rejects: no event, serialized lookup error, still resolves', async () => {
        const { orchestrator, log, eventHistory } = createOrchestrator({
          existsResult: [],
          bookError: new Error('SQLITE_BUSY: database is locked'),
        });

        await expect(orchestrator.processOneDownload(113, { bookId: 5, releaseTitle: 'The Stranger [2026]' })).resolves.toBeUndefined();

        expect(eventHistory.create).not.toHaveBeenCalled();
        const record = (log.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
        expect(record).toMatchObject({ downloadId: 113, bookId: 5, releaseTitle: 'The Stranger [2026]' });
        const logged = record.error as Record<string, unknown>;
        expect(logged).not.toBeInstanceOf(Error);
        expect(logged.type).toBe('Error');
        expect(logged.message).toBe('SQLITE_BUSY: database is locked');
      });

      it('a rejected event write is logged, never thrown at the caller', async () => {
        const { orchestrator, log, eventHistory } = createOrchestrator({
          existsResult: [],
          bookResult: [{ title: 'The Stranger' }],
        });
        eventHistory.create.mockRejectedValue(new Error('insert failed'));

        await expect(orchestrator.processOneDownload(113, { bookId: 5, releaseTitle: 'r' })).resolves.toBeUndefined();
        await new Promise((r) => setImmediate(r));

        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ type: 'Error' }) }),
          expect.stringContaining('Failed to record download_failed event'),
        );
      });
    });

    it('holds for probe failure and reverts book to downloading', async () => {
      const { orchestrator, qualityGateService, broadcaster } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Scan failed'));

      await orchestrator.processOneDownload(1);

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        old_status: 'importing', new_status: 'downloading',
      }));
    });

    it('skips early when download has no bookId', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: { ...completedDownload, bookId: null }, book: null });

      await orchestrator.processOneDownload(1);

      expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
    });

    it('skips early when download has no externalId', async () => {
      const { orchestrator, qualityGateService } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: { ...completedDownload, externalId: null }, book: { ...downloadingBook } });

      await orchestrator.processOneDownload(1);

      expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
    });

    it('reverts book to downloading on unhandled error after promotion', async () => {
      const { orchestrator, qualityGateService, broadcaster, db } = createOrchestrator();
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });
      qualityGateService.processDownload.mockRejectedValue(new Error('Unexpected QG failure'));
      db.update.mockReturnValue(mockDbChain());

      await orchestrator.processOneDownload(1);

      expect(qualityGateService.hold).toHaveBeenCalledWith(1);
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: 1, old_status: 'importing', new_status: 'downloading',
      }));
    });

    it('passes derived ffprobePath to scanAudioDirectory when ffmpegPath is configured', async () => {
      const settingsService = inject<SettingsService>({
        get: vi.fn().mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' }),
      });
      const { orchestrator, qualityGateService, log } = createOrchestrator({ settingsService });
      qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });

      await orchestrator.processOneDownload(1);

      expect(scanAudioDirectory).toHaveBeenCalledWith(
        '/downloads/test',
        { skipCover: true, ffprobePath: '/usr/bin/ffprobe', onWarn: expect.any(Function), onDebug: expect.any(Function), onFilesWithoutCodec: expect.any(Function) },
      );

      const options = vi.mocked(scanAudioDirectory).mock.calls[0]![1]!;
      options.onWarn!('warn-msg', { warnPayload: 1 });
      expect(log.warn).toHaveBeenCalledWith({ warnPayload: 1 }, 'warn-msg');
      options.onDebug!('debug-msg', { debugPayload: 2 });
      expect(log.debug).toHaveBeenCalledWith({ debugPayload: 2 }, 'debug-msg');
    });
  });

  describe('required-wiring contract', () => {
    function makeUnwiredOrchestrator() {
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
        getCompletedDownloadById: vi.fn().mockResolvedValue({ download: baseDownload, book: baseBook }),
        atomicClaim: vi.fn().mockResolvedValue(true),
        hold: vi.fn().mockResolvedValue(undefined),
        processDownload: vi.fn().mockResolvedValue({ action: 'imported', reason: { action: 'imported', holdReasons: [] }, statusTransition: { from: 'checking', to: 'completed' } }),
        approve: vi.fn(),
        reject: vi.fn(),
        getDeferredCleanupCandidates: vi.fn().mockResolvedValue([]),
      };
      const orchestrator = new QualityGateOrchestrator(
        inject<QualityGateService>(qualityGateService),
        inject<Db>(db),
        inject<FastifyBaseLogger>(log),
        inject<DownloadClientService>(downloadClientService),
        {
          eventHistory: inject<EventHistoryService>(eventHistory),
          broadcaster: inject<EventBroadcasterService>(broadcaster),
          blacklistService: inject<BlacklistService>(blacklistService),
        },
      );
      return { orchestrator, log, qualityGateService, broadcaster, db };
    }

    it('processOneDownload() imported path surfaces ServiceWireError instead of converting to pending_review', async () => {
      const { orchestrator, qualityGateService } = makeUnwiredOrchestrator();

      // Imported path needs nudgeImportWorker; swallowing ServiceWireError would hide a composition-root bug.
      await expect(orchestrator.processOneDownload(1)).rejects.toThrow(/QualityGateOrchestrator used before wire/);

      // A pending-review fallback would mask the wiring bug.
      expect(qualityGateService.hold).not.toHaveBeenCalledWith(baseDownload.id);
    });

    it('processOneDownload() unwired path fails BEFORE atomicClaim and book status promotion', async () => {
      const { orchestrator, qualityGateService, broadcaster, db } = makeUnwiredOrchestrator();

      await expect(orchestrator.processOneDownload(1)).rejects.toThrow(/QualityGateOrchestrator used before wire/);

      expect(qualityGateService.atomicClaim).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(broadcaster.emit).not.toHaveBeenCalled();
    });

    it('wire() called twice throws ServiceWireError', () => {
      const { orchestrator } = makeUnwiredOrchestrator();
      orchestrator.wire({ nudgeImportWorker: vi.fn(), bookImportService: {} as never });
      expect(() => orchestrator.wire({ nudgeImportWorker: vi.fn(), bookImportService: {} as never })).toThrow(/QualityGateOrchestrator\.wire\(\) called more than once/);
    });
  });

  describe('optional-dep absence (#725)', () => {
    function buildOrchestratorWithoutDep<K extends keyof QualityGateOrchestratorOptionalDeps>(omit: K) {
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
        getCompletedDownloadById: vi.fn().mockResolvedValue(null),
        atomicClaim: vi.fn().mockResolvedValue(true),
        hold: vi.fn().mockResolvedValue(undefined),
        processDownload: vi.fn().mockResolvedValue({ action: 'imported', reason: { action: 'imported', holdReasons: [] }, statusTransition: { from: 'checking', to: 'completed' } }),
        approve: vi.fn().mockResolvedValue({ id: 1, status: 'importing', download: baseDownload, book: baseBook }),
        reject: vi.fn().mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook }),
        getDeferredCleanupCandidates: vi.fn().mockResolvedValue([]),
      };
      const retrySearchDeps = { log: createMockLogger() } as unknown as RetrySearchDeps;
      const settingsService = { get: vi.fn().mockResolvedValue({ redownloadFailed: true, deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 }) };
      const allDeps: QualityGateOrchestratorOptionalDeps = {
        eventHistory: inject<EventHistoryService>(eventHistory),
        broadcaster: inject<EventBroadcasterService>(broadcaster),
        blacklistService: inject<BlacklistService>(blacklistService),
        retrySearchDeps,
        settingsService: inject<SettingsService>(settingsService),
      };
      const optional = { ...allDeps };
      delete optional[omit];
      const orchestrator = new QualityGateOrchestrator(
        inject<QualityGateService>(qualityGateService),
        inject<Db>(db),
        inject<FastifyBaseLogger>(log),
        inject<DownloadClientService>(downloadClientService),
        optional,
      );
      orchestrator.wire({ nudgeImportWorker: vi.fn(), bookImportService: {} as never });
      return { orchestrator, qualityGateService, db, log, eventHistory, broadcaster, blacklistService };
    }

    it('omitting eventHistory: hold path completes without throwing, no event recorded', async () => {
      const { orchestrator, qualityGateService, eventHistory, broadcaster } = buildOrchestratorWithoutDep('eventHistory');
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'held',
        reason: { ...NULL_REASON, holdReasons: ['narrator_mismatch'] },
        statusTransition: { from: 'checking', to: 'pending_review' },
      });

      await expect(orchestrator.processCompletedDownloads()).resolves.not.toThrow();
      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({ new_status: 'pending_review' }));
    });

    it('omitting broadcaster: hold path completes without throwing, no SSE emitted', async () => {
      const { orchestrator, qualityGateService, broadcaster, eventHistory } = buildOrchestratorWithoutDep('broadcaster');
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'held',
        reason: { ...NULL_REASON, holdReasons: ['narrator_mismatch'] },
        statusTransition: { from: 'checking', to: 'pending_review' },
      });

      await expect(orchestrator.processCompletedDownloads()).resolves.not.toThrow();
      expect(broadcaster.emit).not.toHaveBeenCalled();
      expect(eventHistory.create).toHaveBeenCalled();
    });

    it('omitting blacklistService: auto-reject completes without throwing, no blacklist call', async () => {
      const { orchestrator, qualityGateService, blacklistService } = buildOrchestratorWithoutDep('blacklistService');
      qualityGateService.getCompletedDownloads.mockResolvedValue([{ download: baseDownload, book: baseBook }]);
      qualityGateService.processDownload.mockResolvedValue({
        action: 'rejected', reason: { ...NULL_REASON }, statusTransition: { from: 'checking', to: 'failed' },
      });

      await expect(orchestrator.processCompletedDownloads()).resolves.not.toThrow();
      expect(blacklistService.create).not.toHaveBeenCalled();
    });

    it('omitting retrySearchDeps: reject(retry=true) completes without throwing, no retry triggered', async () => {
      const { orchestrator, qualityGateService } = buildOrchestratorWithoutDep('retrySearchDeps');
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: baseDownload, book: baseBook });

      await expect(orchestrator.reject(1, { retry: true })).resolves.not.toThrow();
      expect(retrySearch).not.toHaveBeenCalled();
    });

    it('omitting settingsService: rejection cleanup defaults to non-destructive (no file delete)', async () => {
      const { orchestrator, qualityGateService } = buildOrchestratorWithoutDep('settingsService');
      const downloadWithOutput = { ...baseDownload, outputPath: '/downloads/test-book' };
      qualityGateService.reject.mockResolvedValue({ id: 1, status: 'failed', download: downloadWithOutput, book: baseBook });

      await expect(orchestrator.reject(1, { retry: false })).resolves.not.toThrow();
    });
  });

  describe('named-key construction (#725)', () => {
    it('object-literal optional deps reject mismatched value types at compile time', () => {
      // Named fields prevent service-shaped dependencies from being silently reordered.
      const db = createMockDb();
      const log = createMockLogger();
      const downloadClientService = inject<DownloadClientService>({});
      const qualityGateService = inject<QualityGateService>({});

      const _bad = new QualityGateOrchestrator(
        qualityGateService, inject<Db>(db), inject<FastifyBaseLogger>(log), downloadClientService,
        // @ts-expect-error eventHistory shape must match EventHistoryService
        { eventHistory: { create: vi.fn(), reason: 'bad_quality' } },
      );
      void _bad;

      const good = new QualityGateOrchestrator(
        qualityGateService, inject<Db>(db), inject<FastifyBaseLogger>(log), downloadClientService,
        {
          eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) }),
          broadcaster: inject<EventBroadcasterService>({ emit: vi.fn() }),
        },
      );
      good.wire({ nudgeImportWorker: vi.fn(), bookImportService: {} as never });
      expect(good).toBeInstanceOf(QualityGateOrchestrator);
    });
  });

});

// Replace classifies QG-owned rows as PIPELINE_ACTIVE, preventing cancellation without extra QG guards (#1857 F15/AC8).
describe('replace × quality-gate ownership (#1857 F15 / AC8)', () => {
  const qgRow = (over: Partial<DownloadRow>): DownloadRow => ({
    id: 1, title: 'QG-owned', clientStatus: 'completed', pipelineStage: 'idle',
    externalId: 'ext-1', downloadClientId: 1, bookId: 5, bookStatusAtGrab: 'wanted',
    infoHash: 'h', guid: 'g', addedAt: new Date('2026-01-01'), ...over,
  } as DownloadRow);

  async function classifyFor(rows: DownloadRow[]) {
    const db = createMockDb();
    // gatherBookBlockers: rows select (orderBy), then pending-auto-jobs select (limit).
    db.select.mockReturnValueOnce(mockDbChain(rows)).mockReturnValueOnce(mockDbChain([]));
    return classifyBlockers(await gatherBookBlockers(db as unknown as Db, 5));
  }

  it.each([
    ['checking', qgRow({ pipelineStage: 'checking' })],
    ['pending_review', qgRow({ pipelineStage: 'pending_review' })],
    ['importing', qgRow({ pipelineStage: 'importing' })],
    ['tracked completed awaiting the gate', qgRow({ clientStatus: 'completed', pipelineStage: 'idle', externalId: 'ext-1' })],
  ] as const)('classifies a %s download as PIPELINE_ACTIVE — replace cancels nothing, QG keeps the row', async (_label, row) => {
    const classification = await classifyFor([row]);
    expect(classification.kind).toBe('pipeline');
    if (classification.kind === 'pipeline') {
      // Held reviews route to Activity; other active stages report processing.
      expect(classification.reason).toBe(row.pipelineStage === 'pending_review' ? 'awaiting_review' : 'processing');
    }
  });

  it('a Blackhole handoff (completed, externalId null) is NOT a QG row and does NOT block replace', async () => {
    const classification = await classifyFor([qgRow({ clientStatus: 'completed', pipelineStage: 'idle', externalId: null })]);
    expect(classification.kind).toBe('clear');
  });

  // A decision barrier proves live interleaving: QG fulfills while replace rejects PIPELINE_ACTIVE (#1857 F25).
  it('replace runs while the QG is held mid-decision: QG completes fulfilled, replace rejects PIPELINE_ACTIVE (cancels nothing)', async () => {
    vi.mocked(scanAudioDirectory).mockResolvedValue(makeScan());
    vi.mocked(resolveSavePath).mockResolvedValue({ resolvedPath: '/downloads/test', originalPath: '/downloads/test' });
    const { orchestrator, qualityGateService } = createOrchestrator();
    const completedDownload = { ...baseDownload, status: 'completed' as const, bookId: 1 };
    const downloadingBook = { ...baseBook, status: 'downloading' as const };
    qualityGateService.getCompletedDownloadById.mockResolvedValue({ download: completedDownload, book: { ...downloadingBook } });

    // Hold processDownload after claim and promotion until replace finishes.
    let signalAtDecision!: () => void;
    const atDecision = new Promise<void>((res) => { signalAtDecision = res; });
    let releaseDecision!: () => void;
    const held = new Promise<void>((res) => { releaseDecision = res; });
    qualityGateService.processDownload.mockImplementation(async () => {
      signalAtDecision();
      await held;
      return { action: 'imported', reason: { action: 'imported', holdReasons: [] }, statusTransition: { from: 'checking', to: 'completed' } };
    });

    const qgPromise = orchestrator.processOneDownload(1);
    await atDecision;

    const replaceDb = createMockDb();
    replaceDb.select
      .mockReturnValueOnce(mockDbChain([qgRow({ clientStatus: 'completed', pipelineStage: 'checking', externalId: 'ext-1' })]))
      .mockReturnValueOnce(mockDbChain([]));
    const replaceGrab = vi.fn().mockResolvedValue({ id: 42 });
    const removeExternalItem = vi.fn().mockResolvedValue(undefined);
    const ctx: ReplaceCtx = {
      db: replaceDb as unknown as Db,
      log: inject<FastifyBaseLogger>(createMockLogger()),
      downloadService: inject<DownloadServiceType>({ removeExternalItem }),
      blacklistService: inject({ create: vi.fn().mockResolvedValue(undefined) }),
      broadcaster: inject({}),
      eventHistory: inject({}),
      grab: replaceGrab,
      safe: (fn) => fn(),
    };

    const replaceOutcome = await runReplaceWorkflow(ctx, { downloadUrl: 'm', title: 'New Release', bookId: 1, replace: true })
      .then(() => ({ ok: true }))
      .catch((e: unknown) => ({ ok: false, error: e }));
    expect(replaceOutcome).toMatchObject({ ok: false, error: { code: 'PIPELINE_ACTIVE' } });
    expect(replaceGrab).not.toHaveBeenCalled();
    expect(removeExternalItem).not.toHaveBeenCalled();
    // Ordering proof: claim and promotion happened, but enqueue is still downstream of the held decision.
    expect(qualityGateService.atomicClaim).toHaveBeenCalledWith(1);
    expect(transitionBookStatus).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({ status: 'importing' }));
    expect(enqueueAutoImport).not.toHaveBeenCalled();

    releaseDecision();
    await expect(qgPromise).resolves.toBeUndefined();
    expect(enqueueAutoImport).toHaveBeenCalledWith(expect.anything(), 1, 1, expect.any(Function), expect.anything());
  });
});
