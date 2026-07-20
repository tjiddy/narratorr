import { createHash } from 'node:crypto';
import { eq, and, asc, lt, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importSubmissions, importSubmissionItems } from '../../db/schema.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import {
  serializeSubmissionForDigest,
  SUBMISSION_ERROR_CODES,
  MAX_SUBMISSION_BYTES,
  FINALIZE_GAPS_REPORT_MAX,
  type CreateSubmissionBody,
  type PutItemsBody,
  type StagedImportItem,
  type SubmissionResponse,
  type StagedItemResultDto,
  type SubmissionStatus,
  type FinalizeGaps,
} from '../../core/import-staging/schemas.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

/** A never-finalized 'receiving' header is GC-eligible after this long (F13 / Retention & GC). */
const STALE_RECEIVING_MS = 48 * 60 * 60 * 1000;

/**
 * A typed staged-submission error the routes map to an HTTP status + named code.
 * `code` is `submission-not-found` for a 404 or a member of `SUBMISSION_ERROR_CODES`.
 */
export class SubmissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message?: string,
    public readonly gaps?: FinalizeGaps,
  ) {
    super(message ?? code);
    this.name = 'SubmissionError';
  }
}

/** Canonical SHA-256 hex digest over a stored ordinal sequence (server authority at finalize). */
function digestItems(source: SubmissionRow['source'], mode: SubmissionRow['mode'], items: StagedImportItem[]): string {
  const serialized = serializeSubmissionForDigest({
    source,
    ...(source === 'manual' && mode ? { mode } : {}),
    items,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

/** The canonical byte size of a single staged item (F58 accumulator unit). */
function stagedItemBytes(item: StagedImportItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/**
 * Inert staged-upload state machine (#1893): create-or-return by clientSubmissionId,
 * idempotent chunked PUTs (byte-budgeted, ordinal-keyed), and a digest-verified
 * finalize that CAS-flips 'receiving' → 'processing'. Nothing here has import side
 * effects — the runner owns processing after finalize. `nudgeRunner` is invoked
 * ONLY on the winning finalize CAS.
 */
export class ImportStagingService {
  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly nudgeRunner: () => void,
  ) {}

  /**
   * Create-or-return by clientSubmissionId: same id + identical digest returns the
   * existing header; same id + different digest → typed 409. A lost create response
   * replayed re-returns the same header (no second row).
   */
  async createSubmission(body: CreateSubmissionBody): Promise<SubmissionResponse> {
    const [existing] = await this.db
      .select()
      .from(importSubmissions)
      .where(eq(importSubmissions.clientSubmissionId, body.clientSubmissionId))
      .limit(1);

    if (existing) {
      if (existing.payloadDigest !== body.payloadDigest) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.digestConflict, 409, 'clientSubmissionId already used with a different payload digest');
      }
      return this.buildSummary(existing);
    }

    const mode = body.source === 'manual' ? body.mode : null;
    const [row] = await this.db
      .insert(importSubmissions)
      .values({
        clientSubmissionId: body.clientSubmissionId,
        payloadDigest: body.payloadDigest,
        source: body.source,
        mode,
        expectedCount: body.expectedCount,
        status: 'receiving',
      })
      .returning();
    this.log.info({ clientSubmissionId: body.clientSubmissionId, source: body.source, expectedCount: body.expectedCount }, 'Staged import submission created');
    return this.buildSummary(row!);
  }

  /**
   * Idempotent chunked upload (F58). Validates ordinal range + intra-request
   * uniqueness before any write, then in ONE transaction: re-PUT of an already-
   * stored ordinal is a no-op (adds 0 bytes); a conflicting-content ordinal → 409;
   * a new ordinal is inserted and its bytes accrue to `receivedBytes`. A PUT that
   * would push `receivedBytes` over the cap → 413 with no state change.
   */
  async putItems(id: number, body: PutItemsBody): Promise<SubmissionResponse> {
    const header = await this.loadHeader(id);
    if (header.status !== 'receiving') {
      throw new SubmissionError(SUBMISSION_ERROR_CODES.submissionNotReceiving, 409, `submission is '${header.status}', not receiving`);
    }

    // Range check (single status, F43) — no write on any out-of-range ordinal.
    for (const row of body.items) {
      if (row.ordinal < 0 || row.ordinal >= header.expectedCount) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalOutOfRange, 400, `ordinal ${row.ordinal} out of range [0, ${header.expectedCount})`);
      }
    }
    // Intra-request duplicate ordinals → 409, no partial write.
    const seen = new Set<number>();
    for (const row of body.items) {
      if (seen.has(row.ordinal)) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalConflict, 409, `duplicate ordinal ${row.ordinal} in request`);
      }
      seen.add(row.ordinal);
    }

    return this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select({ ordinal: importSubmissionItems.ordinal, itemPayload: importSubmissionItems.itemPayload })
        .from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, id));
      const existingByOrdinal = new Map(existingRows.map((r) => [r.ordinal, r.itemPayload]));

      let deltaBytes = 0;
      let newOrdinals = 0;
      const toInsert: { ordinal: number; item: StagedImportItem }[] = [];

      for (const row of body.items) {
        const prior = existingByOrdinal.get(row.ordinal);
        if (prior !== undefined) {
          // Already stored — identical content is a no-op (0 bytes); conflicting content → 409.
          if (JSON.stringify(prior) !== JSON.stringify(row.item)) {
            throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalContentConflict, 409, `ordinal ${row.ordinal} already stored with different content`);
          }
          continue;
        }
        deltaBytes += stagedItemBytes(row.item);
        newOrdinals += 1;
        toInsert.push({ ordinal: row.ordinal, item: row.item });
      }

      if (header.receivedBytes + deltaBytes > MAX_SUBMISSION_BYTES) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.byteBudgetExceeded, 413, 'submission byte budget exceeded');
      }

      for (const { ordinal, item } of toInsert) {
        await tx.insert(importSubmissionItems).values({
          submissionId: id,
          ordinal,
          itemPayload: item,
          path: item.path,
          title: item.title,
          disposition: 'pending',
        });
      }

      const [updated] = await tx
        .update(importSubmissions)
        .set({
          receivedCount: header.receivedCount + newOrdinals,
          receivedBytes: header.receivedBytes + deltaBytes,
          updatedAt: new Date(),
        })
        .where(eq(importSubmissions.id, id))
        .returning();
      return this.buildSummary(updated!);
    });
  }

  /**
   * Verify every ordinal present + digest match, then CAS-flip receiving →
   * processing and nudge the runner ONLY on the winning CAS. Replay on an already-
   * finalized header is a no-op (no re-nudge).
   */
  async finalize(id: number): Promise<SubmissionResponse> {
    const header = await this.loadHeader(id);
    if (header.status !== 'receiving') {
      // Idempotent replay — a second finalize on processing/complete is a no-op.
      return this.buildSummary(header);
    }

    const rows = await this.db
      .select()
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, id))
      .orderBy(asc(importSubmissionItems.ordinal));

    const present = new Set(rows.map((r) => r.ordinal));
    const missing: number[] = [];
    for (let i = 0; i < header.expectedCount; i++) {
      if (!present.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      const gaps: FinalizeGaps = {
        missing: missing.slice(0, FINALIZE_GAPS_REPORT_MAX),
        totalMissing: missing.length,
        truncated: missing.length > FINALIZE_GAPS_REPORT_MAX,
      };
      throw new SubmissionError(SUBMISSION_ERROR_CODES.finalizeGaps, 409, 'submission has missing ordinals', gaps);
    }

    const orderedItems = rows.map((r) => r.itemPayload).filter((p): p is StagedImportItem => p != null);
    const recomputed = digestItems(header.source, header.mode, orderedItems);
    if (recomputed !== header.payloadDigest) {
      throw new SubmissionError(SUBMISSION_ERROR_CODES.digestMismatch, 409, 'finalize digest mismatch');
    }

    const now = new Date();
    const result = await this.db
      .update(importSubmissions)
      .set({ status: 'processing', updatedAt: now })
      .where(and(eq(importSubmissions.id, id), eq(importSubmissions.status, 'receiving')));

    if (getRowsAffected(result) === 1) {
      this.log.info({ submissionId: id }, 'Staged import submission finalized — nudging runner');
      this.nudgeRunner();
    }

    const [after] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    return this.buildSummary(after!);
  }

  /** Query-selected DTO by numeric id. */
  async getById(id: number, includeItems: boolean): Promise<SubmissionResponse> {
    const [header] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    return includeItems ? this.buildDetail(header) : this.buildSummary(header);
  }

  /** Query-selected DTO by clientSubmissionId (by-client lookup). */
  async getByClientId(clientSubmissionId: string, includeItems: boolean): Promise<SubmissionResponse> {
    const [header] = await this.db
      .select()
      .from(importSubmissions)
      .where(eq(importSubmissions.clientSubmissionId, clientSubmissionId))
      .limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    return includeItems ? this.buildDetail(header) : this.buildSummary(header);
  }

  // ── Retention & GC ────────────────────────────────────────────────────────

  /**
   * Stale-'receiving' sweep (5-min lane). A never-finalized 'receiving' header is
   * inert (imported nothing) and GC-eligible after 48h; deleting it cascades its
   * item rows. The `updatedAt < cutoff` guard is the atomic precondition against a
   * concurrent PUT (a live upload keeps bumping `updatedAt`). Returns rows deleted.
   */
  async sweepStaleReceiving(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_RECEIVING_MS);
    const result = await this.db
      .delete(importSubmissions)
      .where(and(eq(importSubmissions.status, 'receiving'), lt(importSubmissions.updatedAt, cutoff)));
    return getRowsAffected(result);
  }

  /**
   * Completed-detail pruning (weekly lane). Item rows for 'complete' submissions
   * older than `retentionDays` are pruned (strict `lt`); the finalized header +
   * aggregate columns are kept INDEFINITELY, after which GET reports
   * `detailsPruned: true` with aggregates only. Returns item rows deleted.
   */
  async pruneCompletedDetails(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const stale = await this.db
      .select({ id: importSubmissions.id })
      .from(importSubmissions)
      .where(and(eq(importSubmissions.status, 'complete'), lt(importSubmissions.completedAt, cutoff)));
    if (stale.length === 0) return 0;
    const result = await this.db
      .delete(importSubmissionItems)
      .where(inArray(importSubmissionItems.submissionId, stale.map((s) => s.id)));
    return getRowsAffected(result);
  }

  // ── DTO assembly ──────────────────────────────────────────────────────────

  private async loadHeader(id: number): Promise<SubmissionRow> {
    const [header] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    return header;
  }

  /** Aggregate counts + processedCount + detailsPruned, sourced live or from frozen columns. */
  private async computeProgress(header: SubmissionRow): Promise<{
    aggregates: { accepted: number; held: number; skipped: number; failed: number };
    processedCount: number;
    detailsPruned: boolean;
    itemRows: ItemRow[];
  }> {
    const itemRows = await this.db
      .select()
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, header.id))
      .orderBy(asc(importSubmissionItems.ordinal));

    const detailsPruned = header.status === 'complete' && itemRows.length === 0 && header.expectedCount > 0;

    if (header.status === 'complete') {
      // Frozen aggregate columns survive item pruning (the durable record).
      const aggregates = {
        accepted: header.acceptedCount,
        held: header.heldCount,
        skipped: header.skippedCount,
        failed: header.failedCount,
      };
      return { aggregates, processedCount: aggregates.accepted + aggregates.held + aggregates.skipped + aggregates.failed, detailsPruned, itemRows };
    }

    // Live counts during receiving/processing (0 during receiving).
    const aggregates = { accepted: 0, held: 0, skipped: 0, failed: 0 };
    for (const row of itemRows) {
      if (row.disposition === 'accepted') aggregates.accepted++;
      else if (row.disposition === 'held') aggregates.held++;
      else if (row.disposition === 'skipped') aggregates.skipped++;
      else if (row.disposition === 'failed') aggregates.failed++;
    }
    const processedCount = aggregates.accepted + aggregates.held + aggregates.skipped + aggregates.failed;
    return { aggregates, processedCount, detailsPruned, itemRows };
  }

  private headerFields(header: SubmissionRow, progress: Awaited<ReturnType<ImportStagingService['computeProgress']>>) {
    return {
      id: header.id,
      clientSubmissionId: header.clientSubmissionId,
      source: header.source,
      ...(header.mode ? { mode: header.mode } : {}),
      status: header.status as SubmissionStatus,
      expectedCount: header.expectedCount,
      receivedCount: header.receivedCount,
      processedCount: progress.processedCount,
      aggregates: progress.aggregates,
      detailsPruned: progress.detailsPruned,
      createdAt: header.createdAt.toISOString(),
      updatedAt: header.updatedAt.toISOString(),
      ...(header.completedAt ? { completedAt: header.completedAt.toISOString() } : {}),
    };
  }

  private async buildSummary(header: SubmissionRow): Promise<SubmissionResponse> {
    const progress = await this.computeProgress(header);
    return { ...this.headerFields(header, progress), itemsIncluded: false };
  }

  private async buildDetail(header: SubmissionRow): Promise<SubmissionResponse> {
    const progress = await this.computeProgress(header);
    // Detail + pruned → the summary arm (aggregates-only permanent record).
    if (progress.detailsPruned) {
      return { ...this.headerFields(header, progress), itemsIncluded: false };
    }
    const items = progress.itemRows.map((row) => this.toItemDto(row));
    return { ...this.headerFields(header, progress), itemsIncluded: true, items };
  }

  private toItemDto(row: ItemRow): StagedItemResultDto {
    const base = { ordinal: row.ordinal, path: row.path, title: row.title };
    switch (row.disposition) {
      case 'accepted':
        return { disposition: 'accepted', ...base, bookId: row.bookId, ...(row.itemPayload != null ? { item: row.itemPayload } : {}) };
      case 'held':
        return { disposition: 'held', ...base, reason: 'recording-review-required', ...(row.existingBookId != null ? { existingBookId: row.existingBookId } : {}) };
      case 'skipped':
        return {
          disposition: 'skipped',
          ...base,
          reason: (row.reason === 'already-importing' ? 'already-importing' : 'already-in-library'),
          ...(row.existingBookId != null ? { existingBookId: row.existingBookId } : {}),
          ...(row.existingTitle != null ? { existingTitle: row.existingTitle } : {}),
        };
      case 'failed':
        return { disposition: 'failed', ...base, message: row.reason ?? 'Import failed — see server logs for details.' };
      case 'pending':
      default:
        return { disposition: 'pending', ...base };
    }
  }
}
