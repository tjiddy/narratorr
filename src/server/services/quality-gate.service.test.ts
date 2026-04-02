import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { QualityGateService, QualityGateServiceError } from './quality-gate.service.js';
import { inject, createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import { downloads } from '../../db/schema.js';

function createService() {
  const db = createMockDb();
  const log = createMockLogger();

  const service = new QualityGateService(
    inject<Db>(db),
    inject<FastifyBaseLogger>(log),
  );

  return { service, db, log };
}

const baseDownload = {
  id: 1, bookId: 1, title: 'Test Book', status: 'completed' as const,
  externalId: 'ext-1', downloadClientId: 1, infoHash: 'abc123',
  protocol: 'torrent' as const, downloadUrl: null, size: 500_000_000,
  seeders: 10, progress: 1, errorMessage: null,
  addedAt: new Date(), completedAt: new Date(), indexerId: 1,
  progressUpdatedAt: null, guid: null, outputPath: null, pendingCleanup: null,
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
  audioBitrateMode: null, audioFileFormat: null, audioFileCount: null, topLevelAudioFileCount: null,
  audibleId: null, goodreadsId: null, seriesId: null, importListId: null,
  lastGrabGuid: null, lastGrabInfoHash: null,
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
  });

  describe('getCompletedDownloads', () => {
    it('returns completed downloads with externalId, left-joined with books', async () => {
      const { service, db } = createService();
      const expected = [{ download: baseDownload, book: baseBook }];
      db.select
        .mockReturnValueOnce(mockDbChain(expected))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, name: 'John Smith' }]));

      const result = await service.getCompletedDownloads();

      expect(result).toEqual(expected);
      const chain = db.select.mock.results[0].value;
      expect(chain.where).toHaveBeenCalledWith(
        and(eq(downloads.status, 'completed'), isNotNull(downloads.externalId)),
      );
    });

    it('returns empty array when no completed downloads exist', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getCompletedDownloads();
      expect(result).toEqual([]);
    });
  });

  describe('processDownload — quality comparison', () => {
    it('auto-imports when download MB/hr is strictly greater than existing', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.action).toBe('imported');
      expect(result.reason.action).toBe('imported');
      expect(result.statusTransition).toEqual({ from: 'checking', to: 'completed' });
    });

    it('auto-rejects when download MB/hr is equal to existing', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 400_000_000 }));

      expect(result.action).toBe('rejected');
      expect(result.statusTransition).toEqual({ from: 'checking', to: 'failed' });
    });

    it('auto-rejects when download MB/hr is less than existing', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 200_000_000 }));

      expect(result.action).toBe('rejected');
    });

    it('auto-imports on tiny positive MB/hr delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 400_000_100 }));

      expect(result.action).toBe('imported');
    });

    it('holds for review when existing book has no quality data (newMbPerHour null)', async () => {
      const { service, db } = createService();
      const noQualityBook = { ...baseBook, size: null, audioTotalSize: null, duration: null, audioDuration: null };
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, noQualityBook, makeScan());

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('no_quality_data');
    });

    it('holds for review when both existing and new quality are null', async () => {
      const { service, db } = createService();
      const noQualityBook = { ...baseBook, size: null, audioTotalSize: null, duration: null, audioDuration: null };
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, noQualityBook, makeScan({ totalDuration: 0 }));

      expect(result.action).toBe('held');
    });
  });

  describe('processDownload — narrator matching', () => {
    it('passes when narrator matches exactly', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));

      expect(result.reason.narratorMatch).toBe(true);
      expect(result.action).toBe('imported');
    });

    it('holds for review when narrator mismatch detected', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }));

      expect(result.reason.narratorMatch).toBe(false);
      expect(result.reason.holdReasons).toContain('narrator_mismatch');
      expect(result.action).toBe('held');
    });

    it('skips narrator check when downloaded metadata has no narrator field', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.reason.narratorMatch).toBeNull();
    });

    it('skips narrator check when existing book has no narrator', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, { ...baseBook, narrators: [] }, makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));

      expect(result.reason.narratorMatch).toBeNull();
    });

    it('passes when multiple narrators on existing book and partial match', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'John Smith' }, { name: 'Jane Doe' }, { name: 'Bob Ross' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }),
      );

      expect(result.reason.narratorMatch).toBe(true);
    });

    it('persists original book.narrator string (not lowercased) on mismatch', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }));

      expect(result.reason.existingNarrator).toBe('John Smith');
      expect(result.reason.downloadNarrator).toBe('Jane Doe');
    });

    it('persists original book.narrator and tagNarrator strings on match', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));

      expect(result.reason.narratorMatch).toBe(true);
      expect(result.reason.existingNarrator).toBe('John Smith');
      expect(result.reason.downloadNarrator).toBe('John Smith');
    });

    it('persists original tagNarrator casing (not lowercased) even on mismatch', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'JANE DOE' }));

      expect(result.reason.downloadNarrator).toBe('JANE DOE');
    });

    it('sets existingNarrator and downloadNarrator to null when book.narrator is null', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, { ...baseBook, narrators: [] }, makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));

      expect(result.reason.existingNarrator).toBeNull();
      expect(result.reason.downloadNarrator).toBeNull();
    });

    it('sets existingNarrator and downloadNarrator to null when tagNarrator is undefined', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.reason.existingNarrator).toBeNull();
      expect(result.reason.downloadNarrator).toBeNull();
    });

    it('preserves multi-narrator original string as existingNarrator', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'John Smith' }, { name: 'Jane Doe' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }),
      );

      expect(result.reason.existingNarrator).toBe('John Smith; Jane Doe');
      expect(result.reason.downloadNarrator).toBe('Jane Doe');
    });

    it('passes when multi-narrator tag matches all book narrators (same order, case-insensitive)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'Travis Baldree' }, { name: 'Jeff Hays' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'travis baldree, jeff hays' }),
      );

      expect(result.reason.narratorMatch).toBe(true);
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('passes when multi-narrator tag matches book narrators in different order', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'Travis Baldree' }, { name: 'Jeff Hays' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Jeff Hays, Travis Baldree' }),
      );

      expect(result.reason.narratorMatch).toBe(true);
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('passes when multi-narrator tag uses different delimiter than book narrator (mixed ; vs ,)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'Travis Baldree' }, { name: 'Jeff Hays' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Travis Baldree, Jeff Hays' }),
      );

      expect(result.reason.narratorMatch).toBe(true);
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('holds when multi-narrator tag has no narrator overlap with book narrators', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'Travis Baldree' }, { name: 'Jeff Hays' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Michael Kramer, Scott Brick' }),
      );

      expect(result.reason.narratorMatch).toBe(false);
      expect(result.reason.holdReasons).toContain('narrator_mismatch');
    });

    it('filters empty tokens from malformed delimiter string in book narrator (e.g. "A, , B")', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      // "Travis Baldree, , Jeff Hays" splits to ["travis baldree", "", "jeff hays"] — empty token removed
      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'Travis Baldree' }, { name: 'Jeff Hays' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Jeff Hays' }),
      );

      expect(result.reason.narratorMatch).toBe(true);
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('skips narrator comparison when book narrator normalizes to zero tokens (whitespace-only)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: '  ' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Jeff Hays' }),
      );

      expect(result.reason.narratorMatch).toBeNull();
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('skips narrator comparison when download tag normalizes to zero tokens (whitespace-only)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(
        baseDownload,
        baseBook,
        makeScan({ totalSize: 600_000_000, tagNarrator: '  ' }),
      );

      expect(result.reason.narratorMatch).toBeNull();
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('compares narrator array values directly without rejoining — entity names are not re-split on punctuation (#71)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      // Book has two narrators stored as discrete entities
      const result = await service.processDownload(
        baseDownload,
        { ...baseBook, narrators: [{ name: 'Travis Baldree' }, { name: 'Jeff Hays' }] },
        makeScan({ totalSize: 600_000_000, tagNarrator: 'Travis Baldree' }),
      );

      // Direct array comparison should match 'Travis Baldree' without re-splitting via delimiter heuristics
      expect(result.reason.narratorMatch).toBe(true);
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });
  });

  describe('processDownload — duration delta', () => {
    it('does not hold at exactly +15% duration delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 1.15 }));

      expect(result.reason.holdReasons).not.toContain('duration_delta');
    });

    it('holds for review at +15.01% duration delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 1.1501 }));

      expect(result.reason.holdReasons).toContain('duration_delta');
    });

    it('does not hold at exactly -15% duration delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 0.85 }));

      expect(result.reason.holdReasons).not.toContain('duration_delta');
    });

    it('holds for review at -15.01% duration delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, totalDuration: 36000 * 0.8499 }));

      expect(result.reason.holdReasons).toContain('duration_delta');
    });

    it('does not hold at 0% duration delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, totalDuration: 36000 }));

      expect(result.reason.holdReasons).not.toContain('duration_delta');
    });
  });

  describe('processDownload — reason JSON', () => {
    it('stores structured reason JSON with all canonical fields on auto-import', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, codec: 'AAC', channels: 1 }));

      expect(result.reason).toEqual(expect.objectContaining({
        action: 'imported', mbPerHour: expect.any(Number), existingMbPerHour: expect.any(Number),
        codec: 'AAC', channels: 1, probeFailure: false, holdReasons: [],
      }));
    });

    it('decision includes book-null case with book-dependent fields null', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, null, makeScan({ totalSize: 600_000_000 }));

      // With null book, existingMbPerHour is null → holds for no_quality_data
      expect(result.action).toBe('held');
      expect(result.reason.existingMbPerHour).toBeNull();
    });
  });

  describe('processDownload — first download (book.path === null)', () => {
    const placeholderBook = { ...baseBook, path: null, size: null, audioTotalSize: null, duration: null, audioDuration: null };

    it('auto-imports when book.path is null and no other hold reasons apply (no narrator conflict)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, placeholderBook, makeScan());

      expect(result.action).toBe('imported');
      expect(result.reason.holdReasons).toHaveLength(0);
    });

    it('auto-imports when book.path is null and new scan has valid duration/size — no no_quality_data, no duration_delta', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, placeholderBook, makeScan({ totalSize: 800_000_000, totalDuration: 36000 }));

      expect(result.action).toBe('imported');
      expect(result.reason.holdReasons).not.toContain('no_quality_data');
      expect(result.reason.holdReasons).not.toContain('duration_delta');
    });

    it('auto-imports when book.path is null even if narrator does not match (narrator comparison skipped for first imports)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      const bookWithNarrator = { ...placeholderBook, narrators: [{ name: 'Jane Doe' }] };

      const result = await service.processDownload(baseDownload, bookWithNarrator, makeScan({ tagNarrator: 'John Smith' }));

      expect(result.action).toBe('imported');
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    });

    it('sets narratorMatch to null for first import regardless of narrator values', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      const bookWithNarrator = { ...placeholderBook, narrators: [{ name: 'Jane Doe' }] };

      const result = await service.processDownload(baseDownload, bookWithNarrator, makeScan({ tagNarrator: 'John Smith' }));

      expect(result.reason.narratorMatch).toBeNull();
    });

    it('auto-imports when book.path is null and narrator does not match (narrator comparison skipped, regression guard)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      const bookWithNarrator = { ...placeholderBook, narrators: [{ name: 'Jane Doe' }] };

      const result = await service.processDownload(baseDownload, bookWithNarrator, makeScan({ tagNarrator: 'John Smith' }));

      expect(result.action).toBe('imported');
      expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
      expect(result.reason.holdReasons).not.toContain('no_quality_data');
      expect(result.reason.holdReasons).not.toContain('duration_delta');
    });

    it('no_quality_data is NOT in hold reasons when book.path is null', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, placeholderBook, makeScan());

      expect(result.reason.holdReasons).not.toContain('no_quality_data');
    });

    it('duration_delta is NOT triggered for placeholder book (duration: 1, path: null) with extreme new duration', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      const bookWithPlaceholderDuration = { ...placeholderBook, duration: 1 };

      const result = await service.processDownload(baseDownload, bookWithPlaceholderDuration, makeScan({ totalDuration: 36000 }));

      expect(result.reason.holdReasons).not.toContain('duration_delta');
    });

    it('auto-imports when book.path is null even if quality metadata fields are populated (metadata-only quality)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      // Book with path null but size + duration from metadata provider (not from probe)
      const metadataBook = { ...baseBook, path: null };

      const result = await service.processDownload(baseDownload, metadataBook, makeScan());

      expect(result.action).toBe('imported');
      expect(result.reason.holdReasons).not.toContain('no_quality_data');
    });

    it('duration_delta IS triggered for existing book (path not null) with large duration change (regression)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      // Book has path set (existing files) and a short duration → extreme delta with 36000s new scan
      const existingBook = { ...baseBook, duration: 1, audioDuration: null, audioTotalSize: null };

      const result = await service.processDownload(baseDownload, existingBook, makeScan({ totalDuration: 36000 }));

      expect(result.reason.holdReasons).toContain('duration_delta');
    });

    it('null-book (book === null) still returns held with no_quality_data (orphan-download behavior unchanged)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, null, makeScan());

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('no_quality_data');
    });
  });

  describe('atomicClaim', () => {
    it('returns true when claim succeeds (status was completed)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      const result = await service.atomicClaim(1);
      expect(result).toBe(true);
    });

    it('returns false when already claimed (no matching row)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.atomicClaim(1);
      expect(result).toBe(false);
    });
  });

  describe('setStatus', () => {
    it('updates download status in DB', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      await service.setStatus(1, 'pending_review');

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('transitions pending_review download to importing and returns context', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'pending_review' }, book: baseBook }]));
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.approve(1);
      expect(result.id).toBe(1);
      expect(result.status).toBe('importing');
      expect(result.download).toBeDefined();
      expect(result.book).toEqual(baseBook);
    });

    it('returns null book when download has no bookId', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'pending_review', bookId: null }, book: null }]));
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.approve(1);
      expect(result.book).toBeNull();
    });

    it('throws QualityGateServiceError INVALID_STATUS when download is not in pending_review status', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'downloading' }, book: baseBook }]));

      await expect(service.approve(1)).rejects.toThrow(QualityGateServiceError);
      await expect(service.approve(1)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });

    it('throws QualityGateServiceError NOT_FOUND when download not found', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      await expect(service.approve(1)).rejects.toThrow(QualityGateServiceError);
      await expect(service.approve(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('reject', () => {
    it('transitions pending_review download to failed and returns context', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'pending_review' }, book: baseBook }]));
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.reject(1);
      expect(result.id).toBe(1);
      expect(result.status).toBe('failed');
      expect(result.download).toBeDefined();
      expect(result.book).toEqual(baseBook);
    });

    it('throws QualityGateServiceError INVALID_STATUS when download is not in pending_review status', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([{ download: { ...baseDownload, status: 'downloading' }, book: baseBook }]));

      await expect(service.reject(1)).rejects.toThrow(QualityGateServiceError);
      await expect(service.reject(1)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });

    it('throws QualityGateServiceError NOT_FOUND when download not found', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      await expect(service.reject(1)).rejects.toThrow(QualityGateServiceError);
      await expect(service.reject(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
        mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false,
        existingNarrator: null, downloadNarrator: null,
        durationDelta: 0.05, existingDuration: null, downloadedDuration: null,
        codec: 'AAC', channels: 1, existingCodec: null, existingChannels: null,
        probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'],
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ reason }]));

      const result = await service.getQualityGateData(1);
      expect(result).toEqual(reason);
    });
  });

  describe('getQualityGateDataBatch', () => {
    const batchReason = {
      action: 'held' as const,
      mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false,
      existingNarrator: null, downloadNarrator: null,
      durationDelta: 0.05, existingDuration: null, downloadedDuration: null,
      codec: 'AAC', channels: 1, existingCodec: null, existingChannels: null,
      probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'],
    };

    it('returns Map of downloadId → QualityDecisionReason for multiple downloads', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([
          { ...baseDownload, id: 1, bookId: 10, status: 'pending_review' },
          { ...baseDownload, id: 2, bookId: 20, status: 'pending_review' },
        ]))
        .mockReturnValueOnce(mockDbChain([
          { downloadId: 1, reason: batchReason },
          { downloadId: 2, reason: { ...batchReason, mbPerHour: 80 } },
        ]));

      const result = await service.getQualityGateDataBatch([1, 2]);

      expect(result).toBeInstanceOf(Map);
      expect(result.get(1)).toEqual(batchReason);
      expect(result.get(2)).toEqual(expect.objectContaining({ mbPerHour: 80 }));
    });

    it('returns null for downloads without bookId', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, id: 1, bookId: null, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getQualityGateDataBatch([1]);
      expect(result.get(1)).toBeNull();
    });

    it('returns null for downloads without held_for_review event', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, id: 1, bookId: 10, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getQualityGateDataBatch([1]);
      expect(result.get(1)).toBeNull();
    });

    it('handles empty download IDs array — returns empty Map', async () => {
      const { service } = createService();

      const result = await service.getQualityGateDataBatch([]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it('returns null for download IDs not found in DB', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getQualityGateDataBatch([999]);
      expect(result.get(999)).toBeNull();
    });

    it('chunks download lookup at 999 and event lookup at 998 for >999 IDs', async () => {
      const { service, db } = createService();
      const ids = Array.from({ length: 999 }, (_, i) => i + 1);
      const allDownloads = ids.map((id) => ({ ...baseDownload, id, bookId: id * 10, status: 'pending_review' as const }));

      db.select
        .mockReturnValueOnce(mockDbChain(allDownloads))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getQualityGateDataBatch(ids);

      expect(db.select).toHaveBeenCalledTimes(3);
      expect(result.size).toBe(999);
    });

    it('keeps both chunks under SQLite limit for large batches', async () => {
      const { service, db } = createService();
      const ids = Array.from({ length: 2000 }, (_, i) => i + 1);
      const allDownloads = ids.map((id) => ({ ...baseDownload, id, bookId: id * 10, status: 'pending_review' as const }));

      const dlChunk1 = allDownloads.slice(0, 999);
      const dlChunk2 = allDownloads.slice(999, 1998);
      const dlChunk3 = allDownloads.slice(1998);

      db.select
        .mockReturnValueOnce(mockDbChain(dlChunk1))
        .mockReturnValueOnce(mockDbChain(dlChunk2))
        .mockReturnValueOnce(mockDbChain(dlChunk3))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getQualityGateDataBatch(ids);

      expect(db.select).toHaveBeenCalledTimes(6);
      expect(result.size).toBe(2000);
    });

    it('selects the most recent held_for_review event when multiple exist', async () => {
      const { service, db } = createService();
      const newestReason = { ...batchReason, mbPerHour: 100 };
      const olderReason = { ...batchReason, mbPerHour: 50 };

      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, id: 1, bookId: 10, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([
          { downloadId: 1, reason: newestReason },
          { downloadId: 1, reason: olderReason },
        ]));

      const result = await service.getQualityGateDataBatch([1]);
      expect(result.get(1)).toEqual(newestReason);
    });
  });
});

describe('Quality gate — narrator array comparison (#71)', () => {
  const bookWithPath = { ...baseBook, path: '/library/test' };

  beforeEach(() => { vi.clearAllMocks(); });

  it('narrator comparison skips (no hold) when book has no narrators (narrators: [])', async () => {
    const { service, db } = createService();
    db.update.mockReturnValue(mockDbChain([]));
    const book = { ...bookWithPath, narrators: [] };

    const result = await service.processDownload(baseDownload, book, { ...makeScan(), tagNarrator: 'John Smith' });

    expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    expect(result.reason.narratorMatch).toBeNull();
  });

  it('narrator comparison skips when download has no narrators — not treated as mismatch', async () => {
    const { service, db } = createService();
    db.update.mockReturnValue(mockDbChain([]));
    const book = { ...bookWithPath, narrators: [{ name: 'John Smith' }] };

    const result = await service.processDownload(baseDownload, book, makeScan());

    expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    expect(result.reason.narratorMatch).toBeNull();
  });

  it('download narrator matches any one of multiple book narrators → accepted (set intersection)', async () => {
    const { service, db } = createService();
    db.update.mockReturnValue(mockDbChain([]));
    const book = { ...bookWithPath, narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }] };

    const result = await service.processDownload(
      baseDownload, book,
      { ...makeScan(), tagNarrator: 'Michael Kramer' },
    );

    expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    expect(result.reason.narratorMatch).toBe(true);
  });

  it('download narrator matches none of multiple book narrators → held', async () => {
    const { service, db } = createService();
    db.update.mockReturnValue(mockDbChain([]));
    const book = { ...bookWithPath, narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }] };

    const result = await service.processDownload(
      baseDownload, book,
      { ...makeScan(), tagNarrator: 'Jim Dale' },
    );

    expect(result.action).toBe('held');
    expect(result.reason.holdReasons).toContain('narrator_mismatch');
    expect(result.reason.narratorMatch).toBe(false);
  });

  it('whitespace-only narrator in existing book → tokenizes to empty, comparison skipped', async () => {
    const { service, db } = createService();
    db.update.mockReturnValue(mockDbChain([]));
    const book = { ...bookWithPath, narrators: [{ name: '   ' }] };

    const result = await service.processDownload(
      baseDownload, book,
      { ...makeScan(), tagNarrator: 'Jim Dale' },
    );

    expect(result.reason.holdReasons).not.toContain('narrator_mismatch');
    expect(result.reason.narratorMatch).toBeNull();
  });

  it('first import (book.path === null) with narrator mismatch → auto-import, narrator check bypassed', async () => {
    const { service, db } = createService();
    db.update.mockReturnValue(mockDbChain([]));
    const book = { ...baseBook, path: null, narrators: [{ name: 'Michael Kramer' }] };

    const result = await service.processDownload(
      baseDownload, book,
      { ...makeScan(), tagNarrator: 'Jim Dale' },
    );

    expect(result.action).toBe('imported');
    expect(result.reason.narratorMatch).toBeNull();
  });

  // #300 — Legacy backward compatibility (readback normalization)
  describe('getQualityGateData — legacy event normalization', () => {
    it('returns null for new fields when stored reason JSON predates the schema change', async () => {
      const { service, db } = createService();
      // Legacy reason missing the 4 new fields
      const legacyReason = {
        action: 'held' as const,
        mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false,
        existingNarrator: null, downloadNarrator: null,
        durationDelta: 0.05, codec: 'AAC', channels: 1,
        probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'],
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ reason: legacyReason }]));

      const result = await service.getQualityGateData(1);

      expect(result).not.toBeNull();
      expect(result!.existingCodec).toBeNull();
      expect(result!.existingChannels).toBeNull();
      expect(result!.existingDuration).toBeNull();
      expect(result!.downloadedDuration).toBeNull();
      // Existing fields preserved
      expect(result!.mbPerHour).toBe(60);
      expect(result!.codec).toBe('AAC');
    });
  });

  describe('getQualityGateDataBatch — legacy event normalization', () => {
    it('normalizes legacy events identically — missing keys become null, not undefined', async () => {
      const { service, db } = createService();
      const legacyReason = {
        action: 'held' as const,
        mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false,
        durationDelta: 0.05, codec: 'AAC', channels: 1,
        probeFailure: false, holdReasons: ['narrator_mismatch'],
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, id: 1, bookId: 10, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ downloadId: 1, reason: legacyReason }]));

      const result = await service.getQualityGateDataBatch([1]);

      const data = result.get(1);
      expect(data).not.toBeNull();
      expect(data!.existingCodec).toBeNull();
      expect(data!.existingChannels).toBeNull();
      expect(data!.existingDuration).toBeNull();
      expect(data!.downloadedDuration).toBeNull();
      // Existing fields preserved
      expect(data!.mbPerHour).toBe(60);
    });
  });

  // #299 — getDeferredCleanupCandidates
  describe('getDeferredCleanupCandidates', () => {
    it('queries with where(isNotNull(downloads.pendingCleanup)) and returns matching rows', async () => {
      const { service, db } = createService();
      const deferredDownload = { ...baseDownload, id: 10, status: 'failed', pendingCleanup: new Date() };
      db.select.mockReturnValue(mockDbChain([deferredDownload]));

      const result = await service.getDeferredCleanupCandidates();

      expect(result).toEqual([deferredDownload]);
      const chain = db.select.mock.results[0].value;
      expect(chain.where).toHaveBeenCalledWith(isNotNull(downloads.pendingCleanup));
    });

    it('returns empty array when no deferred downloads exist', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getDeferredCleanupCandidates();

      expect(result).toEqual([]);
      const chain = db.select.mock.results[0].value;
      expect(chain.where).toHaveBeenCalledWith(isNotNull(downloads.pendingCleanup));
    });
  });
});
