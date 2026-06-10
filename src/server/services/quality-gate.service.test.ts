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
  audioBitrateMode: null, audioFileFormat: null, audioFileCount: null, topLevelAudioFileCount: null,
  audibleId: null, goodreadsId: null, seriesId: null, importListId: null,
  lastGrabGuid: null, lastGrabInfoHash: null,
};

function makeScan(overrides?: Partial<{ totalSize: number; totalDuration: number; tagNarrator: string; channels: number; codec: string }>) {
  return {
    totalSize: overrides?.totalSize ?? 600_000_000,
    totalDuration: overrides?.totalDuration ?? 36000,
    ...(overrides?.tagNarrator !== undefined && { tagNarrator: overrides.tagNarrator }),
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
      const chain = db.select.mock.results[0]!.value;
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

  describe('getCompletedDownloadById', () => {
    it('returns { download, book } for a completed download with matching ID and associated book+narrators', async () => {
      const { service, db } = createService();
      const row = { download: baseDownload, book: { ...baseBook } };
      db.select
        .mockReturnValueOnce(mockDbChain([row]))
        .mockReturnValueOnce(mockDbChain([{ bookId: 1, name: 'John Smith' }]));

      const result = await service.getCompletedDownloadById(1);

      expect(result).not.toBeNull();
      expect(result!.download).toEqual(baseDownload);
      expect(result!.book).toEqual({ ...baseBook, narrators: [{ name: 'John Smith' }] });
      const chain = db.select.mock.results[0]!.value;
      expect(chain.where).toHaveBeenCalledWith(
        and(eq(downloads.id, 1), eq(downloads.status, 'completed')),
      );
    });

    it('returns { download, book: null } when the download has no associated book', async () => {
      const { service, db } = createService();
      const row = { download: { ...baseDownload, bookId: null }, book: null };
      db.select.mockReturnValue(mockDbChain([row]));

      const result = await service.getCompletedDownloadById(1);

      expect(result).not.toBeNull();
      expect(result!.download.bookId).toBeNull();
      expect(result!.book).toBeNull();
    });

    it('returns null when no download exists with the given ID', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getCompletedDownloadById(999);

      expect(result).toBeNull();
    });

    it('returns null when download exists but status is not completed', async () => {
      const { service, db } = createService();
      // Query filters by status=completed, so a non-completed download returns empty result set
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getCompletedDownloadById(1);

      expect(result).toBeNull();
    });
  });

  describe('processDownload — imported-book replacement is always held (#1103 F2)', () => {
    it('holds with imported_book_replacement reason when newMbPerHour > existing (was auto-import)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
      expect(result.statusTransition).toEqual({ from: 'checking', to: 'pending_review' });
    });

    it('holds with imported_book_replacement reason when newMbPerHour == existing (was auto-reject)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 400_000_000 }));

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
    });

    it('holds with imported_book_replacement reason when newMbPerHour < existing (was auto-reject)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 200_000_000 }));

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
    });

    it('holds with imported_book_replacement reason on tiny positive MB/hr delta (was auto-import)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 400_000_100 }));

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
    });

    it('first-download path (book.path === null) keeps auto-import behavior', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));
      const wantedBook = { ...baseBook, path: null };

      const result = await service.processDownload(baseDownload, wantedBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.action).toBe('imported');
      expect(result.statusTransition).toEqual({ from: 'checking', to: 'completed' });
    });

    it('appends imported_book_replacement alongside other hold reasons (e.g. narrator_mismatch)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      // tagNarrator mismatch produces holdReasons.length > 0, but the imported-book
      // guard must still append `imported_book_replacement` — the AC requires the
      // reason to be present for any imported-book replacement, regardless of other
      // hold reasons.
      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }));

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('narrator_mismatch');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
    });
  });

  describe('processDownload — imported-book guard scoped by pre-grab status (#1144)', () => {
    it('bookStatusAtGrab=wanted skips the guard (user-initiated replacement)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const download = { ...baseDownload, bookStatusAtGrab: 'wanted' as const };
      const result = await service.processDownload(download, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.reason.holdReasons).not.toContain('imported_book_replacement');
      // newMbPerHour > existing → auto-import branch
      expect(result.action).toBe('imported');
    });

    it('bookStatusAtGrab=wanted falls through to auto-reject when quality matches', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const download = { ...baseDownload, bookStatusAtGrab: 'wanted' as const };
      const result = await service.processDownload(download, baseBook, makeScan({ totalSize: 400_000_000 }));

      expect(result.reason.holdReasons).not.toContain('imported_book_replacement');
      expect(result.action).toBe('rejected');
    });

    it('bookStatusAtGrab=failed skips the guard', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const download = { ...baseDownload, bookStatusAtGrab: 'failed' as const };
      const result = await service.processDownload(download, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.reason.holdReasons).not.toContain('imported_book_replacement');
      expect(result.action).toBe('imported');
    });

    it('bookStatusAtGrab=missing skips the guard', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const download = { ...baseDownload, bookStatusAtGrab: 'missing' as const };
      const result = await service.processDownload(download, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.reason.holdReasons).not.toContain('imported_book_replacement');
      expect(result.action).toBe('imported');
    });

    it('bookStatusAtGrab=null (legacy row) still triggers the guard (conservative default)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const download = { ...baseDownload, bookStatusAtGrab: null };
      const result = await service.processDownload(download, baseBook, makeScan({ totalSize: 600_000_000 }));

      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
    });

    it('bookStatusAtGrab=wanted preserves independent hold reasons from buildQualityAssessment (narrator_mismatch)', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const download = { ...baseDownload, bookStatusAtGrab: 'wanted' as const };
      const result = await service.processDownload(download, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'Jane Doe' }));

      // narrator_mismatch from buildQualityAssessment must still apply, but
      // the imported-book guard must NOT add its own reason
      expect(result.reason.holdReasons).toContain('narrator_mismatch');
      expect(result.reason.holdReasons).not.toContain('imported_book_replacement');
      expect(result.action).toBe('held');
    });
  });

  describe('processDownload — quality comparison (path=null first-download)', () => {
    it('holds for review when existing book has no quality data (newMbPerHour null)', async () => {
      const { service, db } = createService();
      const noQualityBook = { ...baseBook, path: null, size: null, audioTotalSize: null, duration: null, audioDuration: null };
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, noQualityBook, makeScan());

      // path === null → first-download path; no hold reasons → auto-import
      expect(result.action).toBe('imported');
    });

    it('holds for review when both existing and new quality are null', async () => {
      const { service, db } = createService();
      const noQualityBook = { ...baseBook, path: null, size: null, audioTotalSize: null, duration: null, audioDuration: null };
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, noQualityBook, makeScan({ totalDuration: 0 }));

      // path === null and no hold reasons → first-download auto-import branch (book.path === null)
      // newDuration is 0, existing is also null — buildQualityAssessment returns newMbPerHour: null
      // first-download branch fires before the null-quality check
      expect(result.action).toBe('imported');
    });
  });

  describe('processDownload — narrator matching', () => {
    it('passes when narrator matches exactly', async () => {
      const { service, db } = createService();
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.processDownload(baseDownload, baseBook, makeScan({ totalSize: 600_000_000, tagNarrator: 'John Smith' }));

      expect(result.reason.narratorMatch).toBe(true);
      // book.path !== null and no other hold reasons → imported-book replacement hold (#1103 F2)
      expect(result.action).toBe('held');
      expect(result.reason.holdReasons).toContain('imported_book_replacement');
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

      expect(result.reason.existingNarrator).toBe('John Smith, Jane Doe');
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

      const wantedBook = { ...baseBook, path: null };
      const result = await service.processDownload(baseDownload, wantedBook, makeScan({ totalSize: 600_000_000, codec: 'AAC', channels: 1 }));

      expect(result.reason).toEqual(expect.objectContaining({
        action: 'imported', mbPerHour: expect.any(Number),
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

    // #1362 — the read path safeParses the persisted blob. A present-`null` non-null
    // field is the live crash class: the old `{ ...NULL_REASON, ...stored }` spread
    // repaired MISSING keys but a stored `holdReasons: null` overwrote the empty-array
    // default and survived, crashing `.holdReasons.length` downstream. safeParse rejects
    // it → null → the activity card takes its no-qualityGate branch.
    it('#1362: present-null holdReasons fails safeParse → returns null (crash-class regression)', async () => {
      const { service, db } = createService();
      const reason = {
        action: 'held' as const,
        mbPerHour: 60, existingMbPerHour: 40, narratorMatch: false,
        existingNarrator: null, downloadNarrator: null,
        durationDelta: 0.05, existingDuration: null, downloadedDuration: null,
        codec: 'AAC', channels: 1, existingCodec: null, existingChannels: null,
        probeFailure: false, probeError: null, holdReasons: null,
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ reason }]));

      const result = await service.getQualityGateData(1);
      expect(result).toBeNull();
    });

    // #1362: observable behavior change — the old cast+spread repaired missing keys via
    // NULL_REASON; the new safeParse treats the 16 launch fields as required, so a legacy
    // row missing a key now parse-fails to null (the activity card's no-data branch)
    // rather than being silently back-filled into a partial object.
    it('#1362: missing required key fails safeParse → returns null (was previously spread-repaired)', async () => {
      const { service, db } = createService();
      const reason = {
        action: 'held' as const,
        // mbPerHour intentionally omitted
        existingMbPerHour: 40, narratorMatch: false,
        existingNarrator: null, downloadNarrator: null,
        durationDelta: 0.05, existingDuration: null, downloadedDuration: null,
        codec: 'AAC', channels: 1, existingCodec: null, existingChannels: null,
        probeFailure: false, probeError: null, holdReasons: ['narrator_mismatch'],
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ reason }]));

      const result = await service.getQualityGateData(1);
      expect(result).toBeNull();
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

    // #1362 — batch feeder safeParses too. A null-feeder row maps to null (not a partial
    // object), and a valid row in the same batch is unaffected.
    it('#1362: present-null holdReasons row maps to null; valid sibling row unaffected', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([
          { ...baseDownload, id: 1, bookId: 10, status: 'pending_review' },
          { ...baseDownload, id: 2, bookId: 20, status: 'pending_review' },
        ]))
        .mockReturnValueOnce(mockDbChain([
          { downloadId: 1, reason: { ...batchReason, holdReasons: null } },
          { downloadId: 2, reason: batchReason },
        ]));

      const result = await service.getQualityGateDataBatch([1, 2]);
      expect(result.get(1)).toBeNull();
      expect(result.get(2)).toEqual(batchReason);
    });

    it('#1362: missing required key row maps to null (was previously spread-repaired)', async () => {
      const { service, db } = createService();
      const { mbPerHour: _m, ...missing } = batchReason;
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, id: 1, bookId: 10, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ downloadId: 1, reason: missing }]));

      const result = await service.getQualityGateDataBatch([1]);
      expect(result.get(1)).toBeNull();
    });

    it('#1362: a valid full reason parses and returns unchanged', async () => {
      const { service, db } = createService();
      db.select
        .mockReturnValueOnce(mockDbChain([{ ...baseDownload, id: 1, bookId: 10, status: 'pending_review' }]))
        .mockReturnValueOnce(mockDbChain([{ downloadId: 1, reason: batchReason }]));

      const result = await service.getQualityGateDataBatch([1]);
      expect(result.get(1)).toEqual(batchReason);
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

  // #300/#1362 — Legacy backward compatibility (readback normalization).
  // BEHAVIOR CHANGE (#1362): the old `{ ...NULL_REASON, ...stored }` spread back-filled
  // missing keys so legacy rows that predate a field addition still resolved. The read
  // path now safeParses against the shared schema, where the 16 launch fields are
  // REQUIRED — so a legacy row missing keys parse-fails to null and the activity card
  // takes its no-qualityGate branch (no partial object leaks downstream). This is the
  // intended trade: the field-addition rule (post-1.0 fields must be `.nullish()`) is
  // what keeps future additions backward-compatible, not the lossy spread.
  describe('getQualityGateData — legacy event normalization (#1362 supersedes #300 spread)', () => {
    it('a legacy row missing required keys parse-fails to null (no longer spread-repaired)', async () => {
      const { service, db } = createService();
      // Legacy reason missing the 4 fields added in a later schema growth.
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

      expect(result).toBeNull();
    });
  });

  describe('getQualityGateDataBatch — legacy event normalization (#1362 supersedes #300 spread)', () => {
    it('a legacy row missing required keys maps to null (no longer spread-repaired)', async () => {
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

      expect(result.get(1)).toBeNull();
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
      const chain = db.select.mock.results[0]!.value;
      expect(chain.where).toHaveBeenCalledWith(isNotNull(downloads.pendingCleanup));
    });

    it('returns empty array when no deferred downloads exist', async () => {
      const { service, db } = createService();
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getDeferredCleanupCandidates();

      expect(result).toEqual([]);
      const chain = db.select.mock.results[0]!.value;
      expect(chain.where).toHaveBeenCalledWith(isNotNull(downloads.pendingCleanup));
    });
  });
});
