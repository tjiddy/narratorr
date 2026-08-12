import { eq, and, desc, isNotNull, inArray } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, bookEvents, bookNarrators, narrators } from '@db/schema.js';

import type { BookRow, DownloadRow } from './types.js';
import type { DownloadStatus } from '@shared/schemas/activity.js';
import { transitionDownloadState, completedDisplayDownloadCondition, qualityGateEligibleDownloadCondition } from '../utils/download-state.js';
import { buildQualityAssessment } from './quality-gate.helpers.js';
import { QualityGateServiceError } from './quality-gate.types.js';
import type { QualityDecisionReason } from './quality-gate.types.js';
import { qualityGateReasonSchema } from '@shared/schemas.js';

export { QualityGateServiceError, type QualityDecisionReason } from './quality-gate.types.js';

type BookWithNarrators = BookRow & { narrators?: Array<{ name: string }> };

export type QualityDecision = {
  action: 'imported' | 'rejected' | 'held';
  reason: QualityDecisionReason;
  statusTransition: { from: DownloadStatus; to: DownloadStatus };
};

export class QualityGateService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  /** Batch input for the orchestrator, including books and narrators. */
  async getCompletedDownloads(): Promise<Array<{ download: DownloadRow; book: BookWithNarrators | null }>> {
    const rows = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(qualityGateEligibleDownloadCondition());

    if (rows.length === 0) return rows;

    const bookIds = rows.map(r => r.book?.id).filter((id) => id != null);
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

  async getCompletedDownloadById(downloadId: number): Promise<{ download: DownloadRow; book: BookWithNarrators | null } | null> {
    const rows = await this.db
      .select({ download: downloads, book: books })
      .from(downloads)
      .leftJoin(books, eq(downloads.bookId, books.id))
      .where(and(eq(downloads.id, downloadId), completedDisplayDownloadCondition()))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    if (row.book) {
      const narratorRows = await this.db
        .select({ bookId: bookNarrators.bookId, name: narrators.name })
        .from(bookNarrators)
        .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
        .where(eq(bookNarrators.bookId, row.book.id));
      return { download: row.download, book: { ...row.book, narrators: narratorRows.map(r => ({ name: r.name })) } };
    }

    return { download: row.download, book: null };
  }

  /** Decide quality and persist its download transition; the orchestrator owns side effects. */
  async processDownload(
    download: DownloadRow,
    book: BookWithNarrators | null,
    scanResult: { totalSize: number; totalDuration: number; tagNarrator?: string; channels: number; codec: string },
  ): Promise<QualityDecision> {
    const reason = buildQualityAssessment(scanResult, book);
    const { holdReasons, mbPerHour: newMbPerHour, existingMbPerHour } = reason;

    // Existing-file replacements grabbed while imported require explicit review.
    // Use durable pre-grab status because book.status is importing by gate time; null legacy
    // rows default conservatively to imported, while wanted/failed/missing show replacement intent.
    const grabStatus = download.bookStatusAtGrab ?? 'imported';
    if (book !== null && book.path !== null && grabStatus === 'imported') {
      reason.action = 'held';
      reason.holdReasons.push('imported_book_replacement');
      await this.hold(download.id);
      this.log.info({ downloadId: download.id, holdReasons: reason.holdReasons }, 'Quality gate: held for imported-book replacement review');
      return { action: 'held', reason, statusTransition: { from: 'checking', to: 'pending_review' } };
    }

    if (holdReasons.length > 0) {
      reason.action = 'held';
      await this.hold(download.id);
      this.log.info({ downloadId: download.id, holdReasons }, 'Quality gate: held for review');
      return { action: 'held', reason, statusTransition: { from: 'checking', to: 'pending_review' } };
    } else if (book !== null && book.path === null) {
      // A search placeholder has no existing files to compare.
      reason.action = 'imported';
      await this.autoImport(download.id);
      this.log.info({ downloadId: download.id }, 'Quality gate: first download auto-imported');
      return { action: 'imported', reason, statusTransition: { from: 'checking', to: 'completed' } };
    } else if (newMbPerHour !== null && existingMbPerHour !== null && newMbPerHour > existingMbPerHour) {
      reason.action = 'imported';
      await this.autoImport(download.id);
      this.log.info({ downloadId: download.id, newMbPerHour, existingMbPerHour }, 'Quality gate: auto-import (better quality)');
      return { action: 'imported', reason, statusTransition: { from: 'checking', to: 'completed' } };
    } else if (newMbPerHour !== null && existingMbPerHour !== null) {
      reason.action = 'rejected';
      await this.failPipeline(download.id);
      this.log.info({ downloadId: download.id }, 'Quality gate: auto-rejected (quality same or worse)');
      return { action: 'rejected', reason, statusTransition: { from: 'checking', to: 'failed' } };
    } else {
      reason.action = 'held';
      reason.holdReasons.push('no_quality_data');
      await this.hold(download.id);
      this.log.info({ downloadId: download.id }, 'Quality gate: held for review (insufficient quality data)');
      return { action: 'held', reason, statusTransition: { from: 'checking', to: 'pending_review' } };
    }
  }

  /** Atomically claim a download: `(completed, idle) → (completed, checking)`. Returns true if claimed. */
  async atomicClaim(downloadId: number): Promise<boolean> {
    return transitionDownloadState(this.db, downloadId, {
      expected: { clientStatus: 'completed', pipelineStage: 'idle' },
      pipelineStage: 'checking',
    });
  }

  async hold(downloadId: number): Promise<void> {
    await transitionDownloadState(this.db, downloadId, { pipelineStage: 'pending_review' });
  }

  // Approval resets only the pipeline stage; the import orchestrator reclaims completed/idle.
  async autoImport(downloadId: number): Promise<void> {
    await transitionDownloadState(this.db, downloadId, { pipelineStage: 'idle' });
  }

  /** Sanctioned cross-axis failure: land `(failed, idle)` in one transition. */
  async failPipeline(downloadId: number): Promise<void> {
    await transitionDownloadState(this.db, downloadId, { clientStatus: 'failed', pipelineStage: 'idle' });
  }

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
    if (result[0]!.download.pipelineStage !== 'pending_review') {
      throw new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS');
    }

    await transitionDownloadState(this.db, downloadId, {
      expected: { pipelineStage: 'pending_review' },
      pipelineStage: 'importing',
    });
    this.log.info({ downloadId }, 'Quality gate: download approved for import');

    return { id: downloadId, status: 'importing', download: result[0]!.download, book: result[0]!.book };
  }

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

    const download = result[0]!.download;
    const book = result[0]!.book;

    if (download.pipelineStage !== 'pending_review') {
      throw new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS');
    }

    // Canonical failure tuple must land atomically.
    await transitionDownloadState(this.db, downloadId, {
      expected: { pipelineStage: 'pending_review' },
      clientStatus: 'failed',
      pipelineStage: 'idle',
    });

    return { id: downloadId, status: 'failed', download, book };
  }

  /** Return the most recent held_for_review reason for a pending_review download, or null. */
  async getQualityGateData(downloadId: number): Promise<QualityDecisionReason | null> {
    const events = await this.db
      .select()
      .from(downloads)
      .where(eq(downloads.id, downloadId))
      .limit(1);

    if (events.length === 0) return null;

    const download = events[0]!;
    if (!download.bookId) return null;

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

    // Invalid legacy JSON becomes no data; never expose partial reasons to clients.
    const parsed = qualityGateReasonSchema.safeParse(eventResults[0]!.reason);
    if (!parsed.success) {
      // Log issue paths only; reason values may be sensitive.
      this.log.warn(
        { downloadId, issuePaths: parsed.error.issues.map((i) => i.path.join('.')) },
        'Malformed quality-gate reason — degrading to no-data',
      );
      return null;
    }
    return parsed.data;
  }

  /** Batch-fetch quality gate data into a downloadId → reason-or-null Map. */
  async getQualityGateDataBatch(downloadIds: number[]): Promise<Map<number, QualityDecisionReason | null>> {
    const result = new Map<number, QualityDecisionReason | null>();
    if (downloadIds.length === 0) return result;

    for (const id of downloadIds) {
      result.set(id, null);
    }

    // SQLite allows 999 binds; event queries reserve one for eventType.
    const DOWNLOAD_CHUNK = 999;
    const EVENT_CHUNK = 998;

    const allDownloads: Array<DownloadRow> = [];
    for (let i = 0; i < downloadIds.length; i += DOWNLOAD_CHUNK) {
      const chunk = downloadIds.slice(i, i + DOWNLOAD_CHUNK);
      const rows = await this.db
        .select()
        .from(downloads)
        .where(inArray(downloads.id, chunk));
      allDownloads.push(...rows);
    }

    const validIds = allDownloads
      .filter((dl) => dl.bookId !== null)
      .map((dl) => dl.id);

    if (validIds.length === 0) return result;

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

    // Desc order makes the first event newest. Track processed separately because null is both
    // a parsed result and initial sentinel; otherwise an older valid event can replace a malformed newest.
    const processed = new Set<number>();
    for (const event of allEvents) {
      const { downloadId } = event;
      if (downloadId === null || !result.has(downloadId) || processed.has(downloadId)) continue;
      processed.add(downloadId);
      const parsed = qualityGateReasonSchema.safeParse(event.reason);
      if (!parsed.success) {
        // Log issue paths only; reason values may be sensitive.
        this.log.warn(
          { downloadId, issuePaths: parsed.error.issues.map((i) => i.path.join('.')) },
          'Malformed quality-gate reason — degrading to no-data',
        );
      }
      result.set(downloadId, parsed.success ? parsed.data : null);
    }

    return result;
  }

  async getDeferredCleanupCandidates(): Promise<DownloadRow[]> {
    return this.db
      .select()
      .from(downloads)
      .where(isNotNull(downloads.pendingCleanup));
  }
}
