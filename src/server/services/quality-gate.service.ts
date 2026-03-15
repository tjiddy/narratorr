import { eq, and, desc, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, bookEvents } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { resolveBookQualityInputs } from '../../core/utils/quality.js';
import type { EventHistoryService } from './event-history.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import { revertBookStatus } from '../utils/book-status.js';
import { resolveSavePath } from '../utils/download-path.js';

import type { DownloadRow } from './types.js';

type BookRow = typeof books.$inferSelect;

/** Canonical reason JSON for every quality gate decision. */
export interface QualityDecisionReason {
  action: 'imported' | 'rejected' | 'held';
  mbPerHour: number | null;
  existingMbPerHour: number | null;
  narratorMatch: boolean | null;
  durationDelta: number | null;
  codec: string | null;
  channels: number | null;
  probeFailure: boolean;
  holdReasons: string[];
}

const DURATION_TOLERANCE = 0.15; // 15%

export class QualityGateService {
  private broadcaster?: EventBroadcasterService;

  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private eventHistory: EventHistoryService,
    private blacklistService: BlacklistService,
    private log: FastifyBaseLogger,
    private remotePathMappingService?: RemotePathMappingService,
  ) {}

  /** Set broadcaster for SSE emission (called after service graph construction). */
  setBroadcaster(broadcaster: EventBroadcasterService): void {
    this.broadcaster = broadcaster;
  }

  /**
   * Process all completed downloads through the quality gate.
   * Atomically claims each via completed→checking, then decides: auto-import, auto-reject, or hold.
   */
  async processCompletedDownloads(): Promise<void> {
    // Find completed downloads with externalId (skip handoff/blackhole)
    const completedDownloads = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(and(eq(downloads.status, 'completed'), isNotNull(downloads.externalId)));

    for (const row of completedDownloads) {
      if (!row.download.externalId || !row.download.bookId) {
        this.log.debug({ id: row.download.id }, 'Quality gate: skipping download without externalId or bookId');
        continue;
      }

      try {
        await this.processDownload(row.download, row.book);
      } catch (error) {
        this.log.error({ error, downloadId: row.download.id }, 'Quality gate error');
        // Set pending_review with probeFailure on unhandled error
        await this.setStatus(row.download.id, 'pending_review');
        await this.recordDecision(row.download, row.book, {
          action: 'held',
          mbPerHour: null,
          existingMbPerHour: null,
          narratorMatch: null,
          durationDelta: null,
          codec: null,
          channels: null,
          probeFailure: true,
          holdReasons: ['unhandled_error'],
        });
      }
    }
  }

  /** Process a single download through the quality gate. */
  // eslint-disable-next-line complexity -- linear quality gate decision tree
  private async processDownload(download: DownloadRow, book: BookRow | null): Promise<void> {
    // Atomic claim: completed → checking
    const claimed = await this.atomicClaim(download.id);
    if (!claimed) {
      this.log.debug({ id: download.id }, 'Quality gate: already claimed by another cycle');
      return;
    }

    // SSE: download_status_change (completed → checking)
    if (book) {
      try { this.broadcaster?.emit('download_status_change', { download_id: download.id, book_id: book.id, old_status: 'completed', new_status: 'checking' }); } catch (e) { this.log.debug(e, 'SSE emit failed'); }
    }

    // Resolve save path
    let savePath: string;
    try {
      savePath = await resolveSavePath(download, this.downloadClientService, this.remotePathMappingService);
    } catch (error) {
      this.log.error({ error, downloadId: download.id }, 'Quality gate: failed to resolve save path');
      await this.holdForReview(download, book, { probeFailure: true, holdReasons: ['probe_failed'] });
      return;
    }

    // Probe audio files
    let scanResult;
    try {
      scanResult = await scanAudioDirectory(savePath, { skipCover: true });
    } catch (error) {
      this.log.error({ error, downloadId: download.id }, 'Quality gate: scan failed');
      await this.holdForReview(download, book, { probeFailure: true, holdReasons: ['probe_failed'] });
      return;
    }

    if (!scanResult) {
      this.log.warn({ downloadId: download.id }, 'Quality gate: no audio files found');
      await this.holdForReview(download, book, { probeFailure: true, holdReasons: ['probe_failed'] });
      return;
    }

    // Build comparison data
    const holdReasons: string[] = [];
    const newSizeBytes = scanResult.totalSize;
    const newDurationSeconds = scanResult.totalDuration;
    const newMbPerHour = newDurationSeconds > 0
      ? (newSizeBytes / (1024 * 1024)) / (newDurationSeconds / 3600)
      : null;

    // Resolve existing book quality
    let existingMbPerHour: number | null = null;
    if (book) {
      const existing = resolveBookQualityInputs(book);
      if (existing.sizeBytes && existing.durationSeconds && existing.durationSeconds > 0) {
        existingMbPerHour = (existing.sizeBytes / (1024 * 1024)) / (existing.durationSeconds / 3600);
      }
    }

    // Check narrator match
    let narratorMatch: boolean | null = null;
    if (scanResult.tagNarrator && book?.narrator) {
      const existingNarrators = book.narrator.split(/[,;&]/).map(n => n.trim().toLowerCase());
      const downloadNarrator = scanResult.tagNarrator.trim().toLowerCase();
      narratorMatch = existingNarrators.some(n => n === downloadNarrator);
      if (!narratorMatch) {
        holdReasons.push('narrator_mismatch');
      }
    }

    // Check duration delta
    let durationDelta: number | null = null;
    if (book) {
      const existingInputs = resolveBookQualityInputs(book);
      if (existingInputs.durationSeconds && existingInputs.durationSeconds > 0 && newDurationSeconds > 0) {
        durationDelta = (newDurationSeconds - existingInputs.durationSeconds) / existingInputs.durationSeconds;
        // Hold if delta exceeds ±15% (boundary exclusive: exactly ±15% is OK)
        if (Math.abs(durationDelta) > DURATION_TOLERANCE) {
          holdReasons.push('duration_delta');
        }
      }
    }

    // Channel sanity — stereo/multi-channel flagging is handled in the UI
    // via the channels field in the reason JSON (no hold, just visual flag)

    // Check if existing book has no quality data
    const noExistingQuality = existingMbPerHour === null;
    if (noExistingQuality && book) {
      holdReasons.push('no_quality_data');
    }

    const reason: QualityDecisionReason = {
      action: 'held', // will be overridden below
      mbPerHour: newMbPerHour,
      existingMbPerHour,
      narratorMatch,
      durationDelta,
      codec: scanResult.codec || null,
      channels: scanResult.channels || null,
      probeFailure: false,
      holdReasons,
    };

    // Decision tree
    if (holdReasons.length > 0) {
      // Hold for review
      reason.action = 'held';
      await this.setStatus(download.id, 'pending_review');
      await this.recordDecision(download, book, reason);

      // SSE: download_status_change (checking → pending_review) + review_needed
      if (book) {
        try {
          this.broadcaster?.emit('download_status_change', { download_id: download.id, book_id: book.id, old_status: 'checking', new_status: 'pending_review' });
          this.broadcaster?.emit('review_needed', { download_id: download.id, book_id: book.id, book_title: book.title });
        } catch (e) { this.log.debug(e, 'SSE emit failed'); }
      }

      this.log.info({ downloadId: download.id, holdReasons }, 'Quality gate: held for review');
    } else if (newMbPerHour !== null && existingMbPerHour !== null && newMbPerHour > existingMbPerHour) {
      // Auto-import: quality strictly better
      reason.action = 'imported';
      await this.setStatus(download.id, 'completed');
      await this.recordDecision(download, book, reason);

      // SSE: download_status_change (checking → completed)
      if (book) {
        try { this.broadcaster?.emit('download_status_change', { download_id: download.id, book_id: book.id, old_status: 'checking', new_status: 'completed' }); } catch (e) { this.log.debug(e, 'SSE emit failed'); }
      }

      this.log.info({ downloadId: download.id, newMbPerHour, existingMbPerHour }, 'Quality gate: auto-import (better quality)');
    } else if (newMbPerHour !== null && existingMbPerHour !== null) {
      // Auto-reject: quality same or worse
      reason.action = 'rejected';
      await this.autoReject(download, book, reason);
    } else {
      // Cannot compare — hold for review (should not normally reach here if no_quality_data was caught above)
      reason.action = 'held';
      reason.holdReasons.push('no_quality_data');
      await this.setStatus(download.id, 'pending_review');
      await this.recordDecision(download, book, reason);

      // SSE: download_status_change (checking → pending_review) + review_needed
      if (book) {
        try {
          this.broadcaster?.emit('download_status_change', { download_id: download.id, book_id: book.id, old_status: 'checking', new_status: 'pending_review' });
          this.broadcaster?.emit('review_needed', { download_id: download.id, book_id: book.id, book_title: book.title });
        } catch (e) { this.log.debug(e, 'SSE emit failed'); }
      }

      this.log.info({ downloadId: download.id }, 'Quality gate: held for review (insufficient quality data)');
    }
  }

  /** Atomically claim a download: completed → checking. Returns true if claimed. */
  private async atomicClaim(downloadId: number): Promise<boolean> {
    const result = await this.db
      .update(downloads)
      .set({ status: 'checking' })
      .where(and(eq(downloads.id, downloadId), eq(downloads.status, 'completed')))
      .returning({ id: downloads.id });

    return result.length > 0;
  }

  /** Hold a download for review with partial reason data. */
  private async holdForReview(
    download: DownloadRow,
    book: BookRow | null,
    partial: Pick<QualityDecisionReason, 'probeFailure' | 'holdReasons'>,
  ): Promise<void> {
    await this.setStatus(download.id, 'pending_review');
    await this.recordDecision(download, book, {
      action: 'held',
      mbPerHour: null,
      existingMbPerHour: null,
      narratorMatch: null,
      durationDelta: null,
      codec: null,
      channels: null,
      ...partial,
    });

    // SSE: download_status_change (checking → pending_review) + review_needed
    if (book) {
      try {
        this.broadcaster?.emit('download_status_change', { download_id: download.id, book_id: book.id, old_status: 'checking', new_status: 'pending_review' });
        this.broadcaster?.emit('review_needed', { download_id: download.id, book_id: book.id, book_title: book.title });
      } catch (e) { this.log.debug(e, 'SSE emit failed'); }
    }

    this.log.info({ downloadId: download.id, holdReasons: partial.holdReasons }, 'Quality gate: held for review');
  }

  /** Auto-reject: delete files, blacklist if infoHash present, set failed. */
  private async autoReject(
    download: DownloadRow,
    book: BookRow | null,
    reason: QualityDecisionReason,
  ): Promise<void> {
    await this.setStatus(download.id, 'failed');
    await this.recordDecision(download, book, reason);

    // Blacklist if infoHash present
    if (download.infoHash) {
      try {
        await this.blacklistService.create({
          infoHash: download.infoHash,
          title: download.title,
          bookId: download.bookId ?? undefined,
          reason: 'bad_quality',
        });
        this.log.info({ downloadId: download.id, infoHash: download.infoHash }, 'Quality gate: blacklisted rejected release');
      } catch (err) {
        this.log.warn({ downloadId: download.id, err }, 'Quality gate: failed to blacklist release');
      }
    } else {
      this.log.info({ downloadId: download.id }, 'Quality gate: blacklist skipped — no infoHash');
    }

    // Delete downloaded files via client
    try {
      if (download.downloadClientId && download.externalId) {
        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        if (adapter) {
          await adapter.removeDownload(download.externalId, true);
          this.log.info({ downloadId: download.id }, 'Quality gate: deleted rejected download files');
        }
      }
    } catch (err) {
      this.log.warn({ downloadId: download.id, err }, 'Quality gate: failed to delete download files');
    }

    // Recover book status
    if (book) {
      const revertStatus = await revertBookStatus(this.db, book);

      // SSE: download_status_change + book_status_change (rejected)
      try {
        this.broadcaster?.emit('download_status_change', { download_id: download.id, book_id: book.id, old_status: download.status as DownloadStatus, new_status: 'failed' });
        this.broadcaster?.emit('book_status_change', { book_id: book.id, old_status: book.status as BookStatus, new_status: revertStatus as BookStatus });
      } catch (e) { this.log.debug(e, 'SSE emit failed'); }
    }

    this.log.info({ downloadId: download.id }, 'Quality gate: auto-rejected (quality same or worse)');
  }

  /** Set download status. */
  private async setStatus(downloadId: number, status: DownloadRow['status']): Promise<void> {
    await this.db.update(downloads).set({ status }).where(eq(downloads.id, downloadId));
  }

  /** Record a quality gate decision event. */
  private async recordDecision(
    download: DownloadRow,
    book: BookRow | null,
    reason: QualityDecisionReason,
  ): Promise<void> {
    if (!book) return;

    try {
      await this.eventHistory.create({
        bookId: book.id,
        bookTitle: book.title,
        downloadId: download.id,
        eventType: 'held_for_review',
        source: 'auto',
        reason: { ...reason },
      });
    } catch (err) {
      this.log.warn({ downloadId: download.id, err }, 'Quality gate: failed to record decision event');
    }
  }

  /**
   * Approve a pending_review download — transition to importing.
   * Returns the download ID and new status.
   */
  async approve(downloadId: number): Promise<{ id: number; status: string }> {
    const download = await this.db.select().from(downloads).where(eq(downloads.id, downloadId)).limit(1);
    if (download.length === 0) {
      throw new Error('not found');
    }
    if (download[0].status !== 'pending_review') {
      throw new Error('not pending_review');
    }

    await this.setStatus(downloadId, 'importing');

    // SSE: download_status_change (pending_review → importing)
    if (download[0].bookId) {
      try { this.broadcaster?.emit('download_status_change', { download_id: downloadId, book_id: download[0].bookId, old_status: 'pending_review', new_status: 'importing' }); } catch (e) { this.log.debug(e, 'SSE emit failed'); }
    }

    this.log.info({ downloadId }, 'Quality gate: download approved for import');

    // Record approval event
    if (download[0].bookId) {
      const bookData = await this.db.select().from(books).where(eq(books.id, download[0].bookId)).limit(1);
      if (bookData.length > 0) {
        await this.recordDecision(download[0], bookData[0], {
          action: 'imported',
          mbPerHour: null,
          existingMbPerHour: null,
          narratorMatch: null,
          durationDelta: null,
          codec: null,
          channels: null,
          probeFailure: false,
          holdReasons: [],
        });
      }
    }

    return { id: downloadId, status: 'importing' };
  }

  /**
   * Reject a pending_review download — delete files, blacklist if infoHash, set failed.
   */
  async reject(downloadId: number, _userReason?: string): Promise<{ id: number; status: string }> {
    const result = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(eq(downloads.id, downloadId))
      .limit(1);

    if (result.length === 0) {
      throw new Error('not found');
    }

    const download = result[0].download;
    const book = result[0].book;

    if (download.status !== 'pending_review') {
      throw new Error('not pending_review');
    }

    await this.setStatus(downloadId, 'failed');

    // Record rejection event
    await this.recordDecision(download, book, {
      action: 'rejected',
      mbPerHour: null,
      existingMbPerHour: null,
      narratorMatch: null,
      durationDelta: null,
      codec: null,
      channels: null,
      probeFailure: false,
      holdReasons: [],
    });

    // Blacklist if infoHash present
    if (download.infoHash) {
      try {
        await this.blacklistService.create({
          infoHash: download.infoHash,
          title: download.title,
          bookId: download.bookId ?? undefined,
          reason: 'bad_quality',
        });
        this.log.info({ downloadId, infoHash: download.infoHash }, 'Quality gate: blacklisted rejected release');
      } catch (err) {
        this.log.warn({ downloadId, err }, 'Quality gate: failed to blacklist on reject');
      }
    } else {
      this.log.info({ downloadId }, 'Quality gate: reject blacklist skipped — no infoHash');
    }

    // Delete downloaded files
    try {
      if (download.downloadClientId && download.externalId) {
        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        if (adapter) {
          await adapter.removeDownload(download.externalId, true);
          this.log.info({ downloadId }, 'Quality gate: deleted rejected download files');
        }
      }
    } catch (err) {
      this.log.warn({ downloadId, err }, 'Quality gate: failed to delete files on reject');
    }

    // Recover book status
    if (book) {
      const revertStatus = await revertBookStatus(this.db, book);

      // SSE: download_status_change + book_status_change (rejected)
      try {
        this.broadcaster?.emit('download_status_change', { download_id: downloadId, book_id: book.id, old_status: 'pending_review', new_status: 'failed' });
        this.broadcaster?.emit('book_status_change', { book_id: book.id, old_status: book.status as BookStatus, new_status: revertStatus as BookStatus });
      } catch (e) { this.log.debug(e, 'SSE emit failed'); }
    }

    return { id: downloadId, status: 'failed' };
  }

  /**
   * Get quality gate data for a pending_review download.
   * Returns the most recent held_for_review event reason as QualityDecisionReason.
   */
  async getQualityGateData(downloadId: number): Promise<QualityDecisionReason | null> {
    const events = await this.db
      .select()
      .from(downloads)
      .where(eq(downloads.id, downloadId))
      .limit(1);

    if (events.length === 0) return null;

    const download = events[0];
    if (!download.bookId) return null;

    // Find the most recent held_for_review event for this download
    const eventResults = await this.db
      .select()
      .from(bookEvents)
      .where(and(
        eq(bookEvents.downloadId, downloadId),
        eq(bookEvents.eventType, 'held_for_review'),
      ))
      .orderBy(desc(bookEvents.id))
      .limit(1);

    if (eventResults.length === 0) return null;

    return (eventResults[0].reason as QualityDecisionReason | null) ?? null;
  }
}
