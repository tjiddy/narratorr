import { eq, and, desc, isNotNull, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, bookEvents, bookNarrators, narrators } from '../../db/schema.js';

import type { DownloadRow } from './types.js';
import { buildQualityAssessment } from './quality-gate.helpers.js';
import { QualityGateServiceError, NULL_REASON } from './quality-gate.types.js';
import type { QualityDecisionReason } from './quality-gate.types.js';

export { QualityGateServiceError, type QualityDecisionReason } from './quality-gate.types.js';

type BookRow = typeof books.$inferSelect;
type BookWithNarrators = BookRow & { narrators?: Array<{ name: string }> };

export type QualityDecision = {
  action: 'imported' | 'rejected' | 'held';
  reason: QualityDecisionReason;
  statusTransition: { from: string; to: string };
};

export class QualityGateService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Query completed downloads with externalId, left-joined with books + narrators.
   * Batch-input seam for QualityGateOrchestrator (mirrors ImportService.getEligibleDownloads).
   */
  async getCompletedDownloads(): Promise<Array<{ download: DownloadRow; book: BookWithNarrators | null }>> {
    const rows = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(and(eq(downloads.status, 'completed'), isNotNull(downloads.externalId)));

    if (rows.length === 0) return rows;

    const bookIds = rows.map(r => r.book?.id).filter((id): id is number => id != null);
    const narratorRows = bookIds.length > 0
      ? await this.db
          .select({ bookId: bookNarrators.bookId, name: narrators.name })
          .from(bookNarrators)
          .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
          .where(inArray(bookNarrators.bookId, bookIds))
      : [];
    const narratorMap = new Map<number, Array<{ name: string }>>();
    for (const r of narratorRows) {
      if (!narratorMap.has(r.bookId)) narratorMap.set(r.bookId, []);
      narratorMap.get(r.bookId)!.push({ name: r.name });
    }

    return rows.map(r => ({
      download: r.download,
      book: r.book ? { ...r.book, narrators: narratorMap.get(r.book.id) ?? [] } : null,
    }));
  }

  /**
   * Pure quality decision: given a download, book, and scan result,
   * compute the decision (accept/reject/hold), execute the DB status transition,
   * and return the result for the orchestrator to dispatch side effects.
   */
  async processDownload(
    download: DownloadRow,
    book: BookWithNarrators | null,
    scanResult: { totalSize: number; totalDuration: number; tagNarrator?: string; channels: number; codec: string },
  ): Promise<QualityDecision> {
    // Build quality assessment (pure computation)
    const reason = buildQualityAssessment(scanResult, book);
    const { holdReasons, mbPerHour: newMbPerHour, existingMbPerHour } = reason;

    // Decision tree
    if (holdReasons.length > 0) {
      reason.action = 'held';
      await this.setStatus(download.id, 'pending_review');
      this.log.info({ downloadId: download.id, holdReasons }, 'Quality gate: held for review');
      return { action: 'held', reason, statusTransition: { from: 'checking', to: 'pending_review' } };
    } else if (book !== null && book.path === null) {
      // First download: book is a search placeholder with no files on disk — skip quality comparison
      reason.action = 'imported';
      await this.setStatus(download.id, 'completed');
      this.log.info({ downloadId: download.id }, 'Quality gate: first download auto-imported');
      return { action: 'imported', reason, statusTransition: { from: 'checking', to: 'completed' } };
    } else if (newMbPerHour !== null && existingMbPerHour !== null && newMbPerHour > existingMbPerHour) {
      reason.action = 'imported';
      await this.setStatus(download.id, 'completed');
      this.log.info({ downloadId: download.id, newMbPerHour, existingMbPerHour }, 'Quality gate: auto-import (better quality)');
      return { action: 'imported', reason, statusTransition: { from: 'checking', to: 'completed' } };
    } else if (newMbPerHour !== null && existingMbPerHour !== null) {
      reason.action = 'rejected';
      await this.setStatus(download.id, 'failed');
      this.log.info({ downloadId: download.id }, 'Quality gate: auto-rejected (quality same or worse)');
      return { action: 'rejected', reason, statusTransition: { from: 'checking', to: 'failed' } };
    } else {
      reason.action = 'held';
      reason.holdReasons.push('no_quality_data');
      await this.setStatus(download.id, 'pending_review');
      this.log.info({ downloadId: download.id }, 'Quality gate: held for review (insufficient quality data)');
      return { action: 'held', reason, statusTransition: { from: 'checking', to: 'pending_review' } };
    }
  }

  /** Atomically claim a download: completed → checking. Returns true if claimed. */
  async atomicClaim(downloadId: number): Promise<boolean> {
    const result = await this.db
      .update(downloads)
      .set({ status: 'checking' })
      .where(and(eq(downloads.id, downloadId), eq(downloads.status, 'completed')))
      .returning({ id: downloads.id });

    return result.length > 0;
  }

  /** Set download status. */
  async setStatus(downloadId: number, status: DownloadRow['status']): Promise<void> {
    await this.db.update(downloads).set({ status }).where(eq(downloads.id, downloadId));
  }

  /**
   * Approve a pending_review download — transition to importing.
   * Returns context for the orchestrator to dispatch side effects.
   */
  async approve(downloadId: number): Promise<{ id: number; status: string; download: DownloadRow; book: BookRow | null }> {
    const result = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(eq(downloads.id, downloadId))
      .limit(1);

    if (result.length === 0) {
      throw new QualityGateServiceError('Download not found', 'NOT_FOUND');
    }
    if (result[0].download.status !== 'pending_review') {
      throw new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS');
    }

    await this.setStatus(downloadId, 'importing');
    this.log.info({ downloadId }, 'Quality gate: download approved for import');

    return { id: downloadId, status: 'importing', download: result[0].download, book: result[0].book };
  }

  /**
   * Reject a pending_review download — transition to failed.
   * Returns context for the orchestrator to dispatch side effects.
   */
  async reject(downloadId: number): Promise<{ id: number; status: string; download: DownloadRow; book: BookRow | null }> {
    const result = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(eq(downloads.id, downloadId))
      .limit(1);

    if (result.length === 0) {
      throw new QualityGateServiceError('Download not found', 'NOT_FOUND');
    }

    const download = result[0].download;
    const book = result[0].book;

    if (download.status !== 'pending_review') {
      throw new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS');
    }

    await this.setStatus(downloadId, 'failed');

    return { id: downloadId, status: 'failed', download, book };
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

    const stored = (eventResults[0].reason as QualityDecisionReason | null) ?? null;
    return stored ? { ...NULL_REASON, ...stored } : null;
  }

  /**
   * Batch-fetch quality gate data for multiple downloads.
   * Returns a Map from downloadId → QualityDecisionReason | null.
   * Chunks IN(...) queries at 999 to respect SQLite parameter limits.
   */
  async getQualityGateDataBatch(downloadIds: number[]): Promise<Map<number, QualityDecisionReason | null>> {
    const result = new Map<number, QualityDecisionReason | null>();
    if (downloadIds.length === 0) return result;

    // Initialize all IDs as null (covers not-found and no-bookId cases)
    for (const id of downloadIds) {
      result.set(id, null);
    }

    // SQLite max parameters = 999. Downloads query only binds IN(...) IDs.
    // Events query binds IN(...) IDs + 1 extra for eventType, so chunk at 998.
    const DOWNLOAD_CHUNK = 999;
    const EVENT_CHUNK = 998;

    const allDownloads: Array<typeof downloads.$inferSelect> = [];
    for (let i = 0; i < downloadIds.length; i += DOWNLOAD_CHUNK) {
      const chunk = downloadIds.slice(i, i + DOWNLOAD_CHUNK);
      const rows = await this.db
        .select()
        .from(downloads)
        .where(inArray(downloads.id, chunk));
      allDownloads.push(...rows);
    }

    // Filter to downloads with bookId
    const validIds = allDownloads
      .filter((dl) => dl.bookId !== null)
      .map((dl) => dl.id);

    if (validIds.length === 0) return result;

    // Batch-fetch held_for_review events for valid downloads
    const allEvents: Array<{ downloadId: number | null; reason: unknown }> = [];
    for (let i = 0; i < validIds.length; i += EVENT_CHUNK) {
      const chunk = validIds.slice(i, i + EVENT_CHUNK);
      const rows = await this.db
        .select({ downloadId: bookEvents.downloadId, reason: bookEvents.reason })
        .from(bookEvents)
        .where(and(
          inArray(bookEvents.downloadId, chunk),
          eq(bookEvents.eventType, 'held_for_review'),
        ))
        .orderBy(desc(bookEvents.id));
      allEvents.push(...rows);
    }

    // Map events to downloads — take the first (most recent) event per download
    for (const event of allEvents) {
      if (event.downloadId !== null && !result.has(event.downloadId)) continue;
      if (event.downloadId !== null && result.get(event.downloadId) === null) {
        const stored = (event.reason as QualityDecisionReason | null) ?? null;
        result.set(event.downloadId, stored ? { ...NULL_REASON, ...stored } : null);
      }
    }

    return result;
  }

  /**
   * Query downloads with pendingCleanup set (deferred rejection cleanup candidates).
   * Returns raw download rows — the orchestrator handles seed-time checks and cleanup.
   */
  async getDeferredCleanupCandidates(): Promise<DownloadRow[]> {
    return this.db
      .select()
      .from(downloads)
      .where(isNotNull(downloads.pendingCleanup));
  }
}
