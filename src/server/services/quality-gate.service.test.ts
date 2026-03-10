import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { QualityGateService } from './quality-gate.service.js';
import { inject, createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { EventHistoryService } from './event-history.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';

const mockAdapter = {
  getDownload: vi.fn().mockResolvedValue({ savePath: '/downloads/test', progress: 100, status: 'completed', size: 0 }),
  removeDownload: vi.fn().mockResolvedValue(undefined),
};

function createService() {
  const db = createMockDb();
  const eventHistory = { create: vi.fn().mockResolvedValue({}) };
  const blacklistService = { create: vi.fn().mockResolvedValue({}) };
  const downloadClientService = { getAdapter: vi.fn().mockResolvedValue(mockAdapter) };
  const log = createMockLogger();

  const service = new QualityGateService(
    inject<Db>(db),
    inject<DownloadClientService>(downloadClientService),
    inject<EventHistoryService>(eventHistory),
    inject<BlacklistService>(blacklistService),
    inject<FastifyBaseLogger>(log),
  );

  return { service, db, eventHistory, blacklistService, downloadClientService, log };
}

const baseDownload = {
  id: 1, bookId: 1, title: 'Test Book', status: 'completed' as const,
  externalId: 'ext-1', downloadClientId: 1, infoHash: 'abc123',
  protocol: 'torrent' as const, downloadUrl: null, size: 500_000_000,
  seeders: 10, progress: 1, errorMessage: null,
  addedAt: new Date(), completedAt: new Date(), indexerId: 1,
};

const baseBook = {
  id: 1, title: 'Test Book', authorId: 1, status: 'imported' as const,
  narrator: 'John Smith', size: 400_000_000, duration: 600,
  audioTotalSize: null, audioDuration: 36000, path: '/library/test',
  asin: null, isbn: null, coverUrl: null, description: null,
  publishedDate: null, publisher: null, language: null,
  seriesName: null, seriesPosition: null, genres: null, tags: null,
  rating: null, ratingCount: null, pageCount: null,
  audioBitrate: null, audioCodec: null, audioSampleRate: null,
  audioChannels: null, updatedAt: new Date(), addedAt: new Date(),
};

function makeScan(overrides?: Partial<{ totalSize: number; totalDuration: number; tagNarrator: string; channels: number; codec: string }>) {
  return {
    totalSize: overrides?.totalSize ?? 600_000_000,
    totalDuration: overrides?.totalDuration ?? 36000,
    tagNarrator: overrides?.tagNarrator,
    channels: overrides?.channels ?? 1,
    codec: overrides?.codec ?? 'AAC',
    bitrate: 128000, sampleRate: 44100, bitrateMode: 'cbr' as const,
    fileFormat: 'm4b', fileCount: 1, hasCoverArt: false,
  };
}

describe('QualityGateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getDownload.mockResolvedValue({ savePath: '/downloads/test', progress: 100, status: 'completed', size: 0 });
    mockAdapter.removeDownload.mockResolvedValue(undefined);
  });

  describe('quality comparison', () => {
    it('auto-imports when download MB/hr is strictly greater than existing', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ action: 'imported' }) }),
      );
    });

    it('auto-rejects when download MB/hr is equal to existing', async () => {
      const { service, db, blacklistService } = createService();
      // Existing: 400MB size, 36000s → (400/1.048576)/10 ≈ 38.15 MB/hr
      // Match exactly by using same size
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 400_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(blacklistService.create).toHaveBeenCalled();
    });

    it('auto-rejects when download MB/hr is less than existing', async () => {
      const { service, db, blacklistService } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 200_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(blacklistService.create).toHaveBeenCalled();
    });

    it('auto-imports on tiny positive MB/hr delta', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 400_000_100 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ action: 'imported' }) }),
      );
    });

    it('holds for review when existing book has no quality data', async () => {
      const { service, db, eventHistory } = createService();
      const noQualityBook = { ...baseBook, size: null, audioTotalSize: null, duration: null, audioDuration: null };
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan());
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: noQualityBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ action: 'held', holdReasons: expect.arrayContaining(['no_quality_data']) }),
        }),
      );
    });

    it('holds for review when both existing and new quality are null', async () => {
      const { service, db, eventHistory } = createService();
      const noQualityBook = { ...baseBook, size: null, audioTotalSize: null, duration: null, audioDuration: null };
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalDuration: 0 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: noQualityBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ action: 'held' }) }),
      );
    });
  });

  describe('narrator matching', () => {
    it('passes when narrator matches exactly', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ narratorMatch: true, action: 'imported' }) }),
      );
    });

    it('holds for review when narrator mismatch detected', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ narratorMatch: false, holdReasons: expect.arrayContaining(['narrator_mismatch']) }),
        }),
      );
    });

    it('skips narrator check when downloaded metadata has no narrator field', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ narratorMatch: null }) }),
      );
    });

    it('skips narrator check when existing book has no narrator', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: { ...baseBook, narrator: null } }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ narratorMatch: null }) }),
      );
    });

    it('passes when multiple narrators on existing book and partial match', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: { ...baseBook, narrator: 'John Smith, Jane Doe; Bob Ross' } }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ narratorMatch: true }) }),
      );
    });
  });

  describe('duration delta', () => {
    it('does not hold at exactly +15% duration delta', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 1.15 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ holdReasons: expect.not.arrayContaining(['duration_delta']) }),
        }),
      );
    });

    it('holds for review at +15.01% duration delta', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 1.1501 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ holdReasons: expect.arrayContaining(['duration_delta']) }),
        }),
      );
    });

    it('does not hold at exactly -15% duration delta', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 0.85 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ holdReasons: expect.not.arrayContaining(['duration_delta']) }),
        }),
      );
    });

    it('holds for review at -15.01% duration delta', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 0.8499 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ holdReasons: expect.arrayContaining(['duration_delta']) }),
        }),
      );
    });

    it('does not hold at 0% duration delta', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, totalDuration: 36000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ holdReasons: expect.not.arrayContaining(['duration_delta']) }),
        }),
      );
    });
  });

  describe('error isolation', () => {
    it('sets pending_review with probeFailure flag when scanAudioDirectory returns null', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ probeFailure: true, holdReasons: ['probe_failed'] }) }),
      );
    });

    it('sets pending_review with probeFailure when scan throws (ENOENT)', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ probeFailure: true }) }),
      );
    });

    it('persists download status change even if event history creation fails', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (eventHistory.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(db.update).toHaveBeenCalled();
    });

    it('deletes files and blacklists on auto-reject when infoHash present', async () => {
      const { service, db, blacklistService } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 200_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'bad_quality' }),
      );
      expect(mockAdapter.removeDownload).toHaveBeenCalled();
    });

    it('deletes files and skips blacklist on auto-reject when no infoHash', async () => {
      const { service, db, blacklistService } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 200_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, infoHash: null }, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(blacklistService.create).not.toHaveBeenCalled();
    });
  });

  describe('state transitions', () => {
    it('skips handoff/blackhole downloads where externalId is null', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, externalId: null }, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(scanAudioDirectory).not.toHaveBeenCalled();
    });
  });

  describe('reason JSON', () => {
    it('stores structured reason JSON with all canonical fields on auto-import', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000, codec: 'AAC', channels: 1 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({
            action: 'imported', mbPerHour: expect.any(Number), existingMbPerHour: expect.any(Number),
            codec: 'AAC', channels: 1, probeFailure: false, holdReasons: [],
          }),
        }),
      );
    });

    it('stores reason JSON with probeFailure=true when probe fails', async () => {
      const { service, db, eventHistory } = createService();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.objectContaining({ probeFailure: true }) }),
      );
    });
  });

  describe('approve', () => {
    it('transitions pending_review download to importing', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ ...baseDownload, status: 'pending_review' }]));
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.approve(1);
      expect(result).toEqual({ id: 1, status: 'importing' });
    });

    it('throws when download is not in pending_review status', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ ...baseDownload, status: 'downloading' }]));

      await expect(service.approve(1)).rejects.toThrow('not pending_review');
    });

    it('throws when download not found', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      await expect(service.approve(1)).rejects.toThrow('not found');
    });
  });

  describe('getQualityGateData', () => {
    it('returns null when download not found', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getQualityGateData(999);
      expect(result).toBeNull();
    });

    it('returns null when download has no bookId', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ ...baseDownload, bookId: null }]));

      const result = await service.getQualityGateData(1);
      expect(result).toBeNull();
    });

    it('returns null when no held_for_review event exists', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getQualityGateData(1);
      expect(result).toBeNull();
    });

    it('returns the most recent held_for_review event reason', async () => {
      const { service, db } = createService();
      const reason = {
        action: 'held' as const,
        mbPerHour: 60,
        existingMbPerHour: 40,
        narratorMatch: false,
        durationDelta: 0.05,
        codec: 'AAC',
        channels: 1,
        probeFailure: false,
        holdReasons: ['narrator_mismatch'],
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ reason }]));

      const result = await service.getQualityGateData(1);
      expect(result).toEqual(reason);
    });
  });

  describe('reject', () => {
    it('transitions pending_review download to failed and blacklists', async () => {
      const { service, db, blacklistService } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'pending_review' }, book: baseBook }]));
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.reject(1);
      expect(result).toEqual({ id: 1, status: 'failed' });
      expect(blacklistService.create).toHaveBeenCalled();
    });

    it('skips blacklist when no infoHash and logs reason', async () => {
      const { service, db, blacklistService, log } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'pending_review', infoHash: null }, book: baseBook }]));
      db.update.mockReturnValue(mockDbChain([]));

      await service.reject(1);
      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 1 }), expect.stringContaining('no infoHash'));
    });

    it('throws when download is not in pending_review status', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'downloading' }, book: baseBook }]));

      await expect(service.reject(1)).rejects.toThrow('not pending_review');
    });

    it('throws when download not found', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      await expect(service.reject(1)).rejects.toThrow('not found');
    });
  });

  describe('SSE emissions', () => {
    function createServiceWithBroadcaster() {
      const base = createService();
      const broadcaster = { emit: vi.fn() };
      base.service.setBroadcaster(inject<EventBroadcasterService>(broadcaster));
      return { ...base, broadcaster };
    }

    it('emits download_status_change on atomicClaim (completed→checking)', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, old_status: 'completed', new_status: 'checking',
      }));
    });

    it('emits download_status_change and review_needed on hold (narrator mismatch)', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      // Narrator mismatch triggers hold
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeScan({ tagNarrator: 'Different Narrator' }),
      );
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, old_status: 'checking', new_status: 'pending_review',
      }));
      expect(broadcaster.emit).toHaveBeenCalledWith('review_needed', {
        download_id: 1, book_id: 1, book_title: baseBook.title,
      });
    });

    it('emits download_status_change on auto-import (checking→completed)', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      // Better quality triggers auto-import
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, old_status: 'checking', new_status: 'completed',
      }));
    });

    it('emits download_status_change and book_status_change on auto-reject', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      // Equal quality triggers auto-reject
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 400_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await service.processCompletedDownloads();

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, book_id: 1, new_status: 'failed',
      }));
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
        book_id: 1,
      }));
    });

    it('broadcaster.emit failure does not break processCompletedDownloads', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      broadcaster.emit.mockImplementation(() => { throw new Error('SSE broken'); });
      (scanAudioDirectory as ReturnType<typeof vi.fn>).mockResolvedValue(makeScan({ totalSize: 600_000_000 }));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(mockDbChain([{ download: baseDownload, book: baseBook }]));

      await expect(service.processCompletedDownloads()).resolves.not.toThrow();
    });

    it('approve emits download_status_change (pending_review → importing)', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      // approve() calls db.select().from(downloads).where(...).limit(1)
      db.select.mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review', bookId: 1 }]));
      // approve() calls db.select().from(books).where(...).limit(1) for recording decision
      db.select.mockReturnValueOnce(mockDbChain([baseBook]));
      db.update.mockReturnValue(mockDbChain());
      db.insert.mockReturnValue(mockDbChain());

      await service.approve(1);

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 1, old_status: 'pending_review', new_status: 'importing',
      });
    });

    it('approve does not break when broadcaster.emit throws', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      broadcaster.emit.mockImplementation(() => { throw new Error('SSE broken'); });
      db.select.mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review', bookId: 1 }]));
      db.select.mockReturnValueOnce(mockDbChain([baseBook]));
      db.update.mockReturnValue(mockDbChain());
      db.insert.mockReturnValue(mockDbChain());

      await expect(service.approve(1)).resolves.toEqual({ id: 1, status: 'importing' });
    });

    it('reject emits download_status_change and book_status_change', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      // reject() calls db.select({ download, book }).from(downloads).leftJoin(books)...
      db.select.mockReturnValueOnce(mockDbChain([{
        download: { ...baseDownload, status: 'pending_review', bookId: 1, infoHash: null, downloadClientId: null },
        book: { ...baseBook, status: 'pending_review' },
      }]));
      db.update.mockReturnValue(mockDbChain());
      db.insert.mockReturnValue(mockDbChain());

      await service.reject(1);

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 1, old_status: 'pending_review', new_status: 'failed',
      });
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
        book_id: 1, old_status: 'pending_review', new_status: 'imported',
      });
    });

    it('reject does not break when broadcaster.emit throws', async () => {
      const { service, db, broadcaster } = createServiceWithBroadcaster();
      broadcaster.emit.mockImplementation(() => { throw new Error('SSE broken'); });
      db.select.mockReturnValueOnce(mockDbChain([{
        download: { ...baseDownload, status: 'pending_review', bookId: 1, infoHash: null, downloadClientId: null },
        book: { ...baseBook, status: 'pending_review' },
      }]));
      db.update.mockReturnValue(mockDbChain());
      db.insert.mockReturnValue(mockDbChain());

      await expect(service.reject(1)).resolves.toEqual({ id: 1, status: 'failed' });
    });
  });
});
