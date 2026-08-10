import { createHash } from 'node:crypto';
import { eq, ne, and, asc, lt, inArray, sql } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importSubmissions, importSubmissionItems } from '@db/schema.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { serializeDbWrite } from '../utils/db-write-lane.js';
import { isUniqueViolation } from '@shared/error-message.js';
import { buildHeaderFields, drizzleHeaderInput, reportRowToDto, completeProgress, liveProgress } from './import-submission-dto.js';
import {
  serializeSubmissionForDigest,
  stagedImportItemSchema,
  SUBMISSION_ERROR_CODES,
  MAX_SUBMISSION_BYTES,
  FINALIZE_GAPS_REPORT_MAX,
  type CreateSubmissionBody,
  type PutItemsBody,
  type StagedImportItem,
  type SubmissionResponse,
  type SubmissionBulkDeleteResponse,
  type StagedItemResultDto,
  type SubmissionAggregates,
  type ItemDisposition,
  type FinalizeGaps,
} from '@core/import-staging/schemas.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

const STALE_RECEIVING_MS = 48 * 60 * 60 * 1000;

// Keep well below the 48h GC cutoff so abandoned uploads remain visible before deletion.
export const ABANDONED_UPLOAD_GRACE_MS = 15 * 60 * 1000;

const CLIENT_SUBMISSION_ID_UNIQUE = /UNIQUE constraint failed.*(?:import_submissions_client_submission_id_unique|import_submissions\.client_submission_id)/;

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

function digestItems(source: SubmissionRow['source'], mode: SubmissionRow['mode'], items: StagedImportItem[]): string {
  const serialized = serializeSubmissionForDigest({
    source,
    ...(source === 'manual' && mode ? { mode } : {}),
    items,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

function stagedItemBytes(item: StagedImportItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/**
 * A run is noise only when it finished with nothing to revisit. Reading the frozen header
 * counters keeps this correct for runs whose item details were already pruned.
 */
function cleanCompleted() {
  return and(
    eq(importSubmissions.status, 'complete'),
    eq(importSubmissions.heldCount, 0),
    eq(importSubmissions.skippedCount, 0),
    eq(importSubmissions.failedCount, 0),
  );
}

/** Staging stays inert until a finalize CAS wins; only that winner nudges the import runner. */
export class ImportStagingService {
  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly nudgeRunner: () => void,
  ) {}

  /** Serialize whole read/decide/write sequences, not only transactions; this coordinates one process. */
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    return serializeDbWrite(this.db, fn);
  }

  /** A unique-index loser re-reads so identical concurrent creates stay idempotent. */
  async createSubmission(body: CreateSubmissionBody): Promise<SubmissionResponse> {
    const existing = await this.findHeaderByClientId(body.clientSubmissionId);
    if (existing) return this.createOrReturn(existing, body.payloadDigest);

    const mode = body.source === 'manual' ? body.mode : null;
    try {
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
      return await this.buildSummary(row!);
    } catch (error: unknown) {
      if (isUniqueViolation(error, CLIENT_SUBMISSION_ID_UNIQUE)) {
        const raced = await this.findHeaderByClientId(body.clientSubmissionId);
        if (raced) return this.createOrReturn(raced, body.payloadDigest);
      }
      throw error;
    }
  }

  private async findHeaderByClientId(clientSubmissionId: string): Promise<SubmissionRow | undefined> {
    const [header] = await this.db
      .select()
      .from(importSubmissions)
      .where(eq(importSubmissions.clientSubmissionId, clientSubmissionId))
      .limit(1);
    return header;
  }

  private createOrReturn(existing: SubmissionRow, payloadDigest: string): Promise<SubmissionResponse> {
    if (existing.payloadDigest !== payloadDigest) {
      throw new SubmissionError(SUBMISSION_ERROR_CODES.digestConflict, 409, 'clientSubmissionId already used with a different payload digest');
    }
    return this.buildSummary(existing);
  }

  /** Idempotent by ordinal; content conflicts fail and the byte cap is enforced atomically. */
  async putItems(id: number, body: PutItemsBody): Promise<SubmissionResponse> {
    const seen = new Set<number>();
    for (const row of body.items) {
      if (seen.has(row.ordinal)) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalConflict, 409, `duplicate ordinal ${row.ordinal} in request`);
      }
      seen.add(row.ordinal);
    }

    // Serialize status/range reads, ordinal inserts, and the counter CAS as one transaction.
    const updated = await this.serializeWrite(() => this.db.transaction(async (tx) => {
      const [header] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
      if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
      if (header.status !== 'receiving') {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.submissionNotReceiving, 409, `submission is '${header.status}', not receiving`);
      }

      for (const row of body.items) {
        if (row.ordinal < 0 || row.ordinal >= header.expectedCount) {
          throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalOutOfRange, 400, `ordinal ${row.ordinal} out of range [0, ${header.expectedCount})`);
        }
      }

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
          // Validate the persisted row before comparison; malformed payloads fail closed.
          const priorItem = this.parseStoredItemOrThrow(prior, row.ordinal);
          if (JSON.stringify(priorItem) !== JSON.stringify(row.item)) {
            throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalContentConflict, 409, `ordinal ${row.ordinal} already stored with different content`);
          }
          continue;
        }
        deltaBytes += stagedItemBytes(row.item);
        newOrdinals += 1;
        toInsert.push({ ordinal: row.ordinal, item: row.item });
      }

      // Guard against current bytes and status; zero rows distinguishes a cap or state race below.
      const now = new Date();
      const result = await tx
        .update(importSubmissions)
        .set({
          receivedCount: sql`${importSubmissions.receivedCount} + ${newOrdinals}`,
          receivedBytes: sql`${importSubmissions.receivedBytes} + ${deltaBytes}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(importSubmissions.id, id),
            eq(importSubmissions.status, 'receiving'),
            sql`${importSubmissions.receivedBytes} + ${deltaBytes} <= ${MAX_SUBMISSION_BYTES}`,
          ),
        );
      if (getRowsAffected(result) !== 1) {
        const [current] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
        if (current && current.status === 'receiving') {
          throw new SubmissionError(SUBMISSION_ERROR_CODES.byteBudgetExceeded, 413, 'submission byte budget exceeded');
        }
        throw new SubmissionError(SUBMISSION_ERROR_CODES.submissionNotReceiving, 409, `submission is '${current?.status ?? 'gone'}', not receiving`);
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

      const [after] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
      return after!;
    }));
    return this.buildSummary(updated);
  }

  /** Verify gaps and digest, then CAS to processing; only the winning commit nudges once. */
  async finalize(id: number): Promise<SubmissionResponse> {
    return this.serializeWrite(() => this.finalizeOnce(id));
  }

  private async finalizeOnce(id: number): Promise<SubmissionResponse> {
    // Keep verification and transition in one transaction; nudge only after commit.
    const { header, nudged } = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
      if (!current) throw new SubmissionError('submission-not-found', 404, 'submission not found');
      if (current.status !== 'receiving') {
        return { header: current, nudged: false };
      }

      const rows = await tx
        .select()
        .from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, id))
        .orderBy(asc(importSubmissionItems.ordinal));

      const present = new Set(rows.map((r) => r.ordinal));
      const missing: number[] = [];
      for (let i = 0; i < current.expectedCount; i++) {
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

      // Validate stored JSON before it feeds the authoritative digest.
      const orderedItems = rows
        .filter((r) => r.itemPayload != null)
        .map((r) => this.parseStoredItemOrThrow(r.itemPayload, r.ordinal));
      const recomputed = digestItems(current.source, current.mode, orderedItems);
      if (recomputed !== current.payloadDigest) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.digestMismatch, 409, 'finalize digest mismatch');
      }

      const now = new Date();
      const result = await tx
        .update(importSubmissions)
        .set({ status: 'processing', updatedAt: now })
        .where(and(eq(importSubmissions.id, id), eq(importSubmissions.status, 'receiving')));
      const [after] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
      // Stale cleanup may win before the CAS; report 404 and do not nudge.
      if (!after) throw new SubmissionError('submission-not-found', 404, 'submission not found');
      return { header: after, nudged: getRowsAffected(result) === 1 };
    });

    if (nudged) {
      this.log.info({ submissionId: id }, 'Staged import submission finalized — nudging runner');
      this.nudgeRunner();
    }
    return this.buildSummary(header);
  }

  async getById(id: number, includeItems: boolean): Promise<SubmissionResponse> {
    const [header] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    return includeItems ? this.buildDetail(header) : this.buildSummary(header);
  }

  async getByClientId(clientSubmissionId: string, includeItems: boolean): Promise<SubmissionResponse> {
    const [header] = await this.db
      .select()
      .from(importSubmissions)
      .where(eq(importSubmissions.clientSubmissionId, clientSubmissionId))
      .limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    return includeItems ? this.buildDetail(header) : this.buildSummary(header);
  }

  /** Serialize the delete with PUT/finalize; re-read zero rows to distinguish 404 from 409. */
  async deleteSubmission(id: number): Promise<{ success: true }> {
    const affected = await this.serializeWrite(async () => {
      const result = await this.db
        .delete(importSubmissions)
        .where(and(eq(importSubmissions.id, id), ne(importSubmissions.status, 'processing')));
      return getRowsAffected(result);
    });
    if (affected === 1) {
      this.log.info({ submissionId: id }, 'Import submission deleted');
      return { success: true };
    }
    const [header] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    throw new SubmissionError(SUBMISSION_ERROR_CODES.submissionInFlight, 409, `submission is '${header.status}' and still importing`);
  }

  /** The manual clear and the retention pass share this predicate so eligibility cannot drift. */
  async deleteCleanCompleted(): Promise<SubmissionBulkDeleteResponse> {
    // Project the ids from the delete itself; a separate pre-read could name rows it never removed.
    const rows = await this.db
      .delete(importSubmissions)
      .where(cleanCompleted())
      .returning({ id: importSubmissions.id });
    const ids = rows.map((r) => r.id);
    this.log.info({ count: ids.length }, 'Clean completed import submissions cleared');
    return { deleted: ids.length, ids };
  }

  /** Retention for the same clean-completed set; a null completedAt never satisfies the cutoff. */
  async pruneCleanCompleted(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .delete(importSubmissions)
      .where(and(cleanCompleted(), lt(importSubmissions.completedAt, cutoff)))
      .returning({ id: importSubmissions.id });
    this.log.info({ count: rows.length, retentionDays }, 'Clean completed import submissions pruned');
    return rows.length;
  }

  /** The strict `updatedAt` guard preserves uploads whose concurrent PUT refreshed them. */
  async sweepStaleReceiving(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_RECEIVING_MS);
    const result = await this.db
      .delete(importSubmissions)
      .where(and(eq(importSubmissions.status, 'receiving'), lt(importSubmissions.updatedAt, cutoff)));
    return getRowsAffected(result);
  }

  /** Prune completed item details but retain their headers and aggregates indefinitely. */
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

  /** Summary polling must not load `itemPayload`; completed aggregates survive detail pruning. */
  private async computeProgress(header: SubmissionRow, loadItems: boolean): Promise<{
    aggregates: SubmissionAggregates;
    processedCount: number;
    detailsPruned: boolean;
    itemRows: ItemRow[];
  }> {
    const itemRows = loadItems
      ? await this.db
          .select()
          .from(importSubmissionItems)
          .where(eq(importSubmissionItems.submissionId, header.id))
          .orderBy(asc(importSubmissionItems.ordinal))
      : [];

    if (header.status === 'complete') {
      const counts: SubmissionAggregates = {
        accepted: header.acceptedCount,
        held: header.heldCount,
        skipped: header.skippedCount,
        failed: header.failedCount,
      };
      const [anyItem] = await this.db
        .select({ id: importSubmissionItems.id })
        .from(importSubmissionItems)
        .where(eq(importSubmissionItems.submissionId, header.id))
        .limit(1);
      return { ...completeProgress(counts, header.expectedCount, !!anyItem), itemRows };
    }

    const dispositionRows = await this.db
      .select({ disposition: importSubmissionItems.disposition })
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, header.id));
    return { ...liveProgress(dispositionRows.map((r) => r.disposition as ItemDisposition)), itemRows };
  }

  private headerFields(header: SubmissionRow, progress: Awaited<ReturnType<ImportStagingService['computeProgress']>>) {
    return buildHeaderFields(drizzleHeaderInput(header), progress);
  }

  private async buildSummary(header: SubmissionRow): Promise<SubmissionResponse> {
    const progress = await this.computeProgress(header, false);
    return { ...this.headerFields(header, progress), itemsIncluded: false };
  }

  private async buildDetail(header: SubmissionRow): Promise<SubmissionResponse> {
    const progress = await this.computeProgress(header, true);
    if (progress.detailsPruned) {
      return { ...this.headerFields(header, progress), itemsIncluded: false };
    }
    const items = progress.itemRows.map((row) => this.toItemDto(row));
    return { ...this.headerFields(header, progress), itemsIncluded: true, items };
  }

  /** SQLite does not enforce the JSON type: undefined is pruned, null malformed, and object validated. */
  private projectAcceptedItem(row: ItemRow): StagedImportItem | null | undefined {
    if (row.itemPayload == null) return undefined;
    const parsed = stagedImportItemSchema.safeParse(row.itemPayload);
    if (!parsed.success) {
      this.log.warn({ submissionId: row.submissionId, ordinal: row.ordinal }, 'Persisted staged item failed validation on read');
      return null;
    }
    return parsed.data;
  }

  /** Mutation reads fail closed before malformed JSON participates in equality or digest decisions. */
  private parseStoredItemOrThrow(payload: unknown, ordinal: number): StagedImportItem {
    const parsed = stagedImportItemSchema.safeParse(payload);
    if (!parsed.success) {
      this.log.warn({ ordinal }, 'Persisted staged item failed validation at a mutation read boundary');
      throw new SubmissionError(SUBMISSION_ERROR_CODES.itemInvalid, 422, `persisted staged item at ordinal ${ordinal} failed validation`);
    }
    return parsed.data;
  }

  private toItemDto(row: ItemRow): StagedItemResultDto {
    // Accepted alone exposes validated item payload; every other disposition uses the shared projection.
    if (row.disposition === 'accepted') {
      const item = this.projectAcceptedItem(row);
      return { disposition: 'accepted', ordinal: row.ordinal, path: row.path, title: row.title, bookId: row.bookId, ...(item !== undefined ? { item } : {}) };
    }
    return reportRowToDto(row);
  }
}
