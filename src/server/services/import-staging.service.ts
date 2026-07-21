import { createHash } from 'node:crypto';
import { eq, and, asc, lt, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importSubmissions, importSubmissionItems } from '../../db/schema.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { isUniqueViolation } from '../../shared/error-message.js';
import { buildHeaderFields, reportRowToDto, completeProgress, liveProgress } from './import-submission-dto.js';
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
  type StagedItemResultDto,
  type SubmissionAggregates,
  type ItemDisposition,
  type FinalizeGaps,
} from '../../core/import-staging/schemas.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

/** A never-finalized 'receiving' header is GC-eligible after this long (F13 / Retention & GC). */
const STALE_RECEIVING_MS = 48 * 60 * 60 * 1000;

/**
 * A 'receiving' submission whose `updatedAt` is strictly older than this is an
 * ABANDONED upload — inert, imported nothing, and surfaced by the attention read
 * (#1894). Homed here beside `STALE_RECEIVING_MS`; a live upload bumps `updatedAt`
 * on every PUT so an actively-arriving partial never qualifies. Invariant:
 * `ABANDONED_UPLOAD_GRACE_MS` (15 min) ≪ `STALE_RECEIVING_MS` (48 h), so the
 * abandoned banner is reachable for well over a day before the stale sweep deletes
 * the header. The boundary is strict `<` (matching the `lt` retention convention).
 */
export const ABANDONED_UPLOAD_GRACE_MS = 15 * 60 * 1000;

/** Matches the `client_submission_id` unique-index violation for race-safe create-or-return (F15). */
const CLIENT_SUBMISSION_ID_UNIQUE = /UNIQUE constraint failed.*(?:import_submissions_client_submission_id_unique|import_submissions\.client_submission_id)/;

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
  /**
   * In-process serialization lane for MUTATING transactions (F36). A libSQL
   * connection permits only one transaction at a time, so two overlapping
   * `db.transaction` calls on the shared connection corrupt with SQLITE_BUSY /
   * "SQL statements in progress". Routing PUT and finalize through one chain means no
   * two of them ever overlap on the connection: each runs to commit before the next
   * begins, giving deterministic idempotency (two finalizes both resolve to
   * 'processing') and clean ordering (a PUT racing finalize sees the committed state,
   * not a corrupted tx). The chain survives rejections so one failure never wedges the
   * lane. This is the single-process supported path; cross-connection contention (the
   * retention-cleanup races) is a separate durable-CAS backstop and intentionally not
   * serialized here.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly nudgeRunner: () => void,
  ) {}

  /** Run a mutating operation on the serialized write lane (see `writeChain`). */
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Create-or-return by clientSubmissionId: same id + identical digest returns the
   * existing header; same id + different digest → typed 409. A lost create response
   * replayed re-returns the same header (no second row).
   *
   * Race-safe (F15): the read-then-insert is not atomic, so two overlapping identical
   * creates can both observe no row. The insert's `clientSubmissionId` unique index
   * lets exactly one win; the loser catches the unique violation and re-reads, so it
   * also returns create-or-return (same id / same digest → 409) instead of leaking a
   * raw 5xx. Only the header unique violation is handled — any other error propagates.
   */
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
      // A concurrent identical create won the unique index — re-read and honour the
      // same create-or-return contract rather than surfacing a raw unique violation.
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

  /** Create-or-return on an existing header: identical digest → the header, else typed 409. */
  private createOrReturn(existing: SubmissionRow, payloadDigest: string): Promise<SubmissionResponse> {
    if (existing.payloadDigest !== payloadDigest) {
      throw new SubmissionError(SUBMISSION_ERROR_CODES.digestConflict, 409, 'clientSubmissionId already used with a different payload digest');
    }
    return this.buildSummary(existing);
  }

  /**
   * Idempotent chunked upload (F58). Validates ordinal range + intra-request
   * uniqueness before any write, then in ONE transaction: re-PUT of an already-
   * stored ordinal is a no-op (adds 0 bytes); a conflicting-content ordinal → 409;
   * a new ordinal is inserted and its bytes accrue to `receivedBytes`. A PUT that
   * would push `receivedBytes` over the cap → 413 with no state change.
   */
  async putItems(id: number, body: PutItemsBody): Promise<SubmissionResponse> {
    // Intra-request duplicate ordinals → 409, no partial write (pure, no state).
    const seen = new Set<number>();
    for (const row of body.items) {
      if (seen.has(row.ordinal)) {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalConflict, 409, `duplicate ordinal ${row.ordinal} in request`);
      }
      seen.add(row.ordinal);
    }

    // EVERYTHING that reads or writes mutable header state runs in ONE transaction
    // (F1), serialized on the write lane (F36) so it never overlaps a concurrent PUT
    // or finalize on the shared connection: the status/range gate, the existing-ordinal
    // read, the byte-cap check, the ordinal inserts, and the counter update are atomic.
    // The counter update is a CAS-guarded conditional increment — `WHERE
    // status='receiving' AND receivedBytes + delta <= cap`, applied with SQL-relative
    // `+=` — so two chunks cannot both read the same counters and lose an increment or
    // slip past the cap, and a PUT that raced a finalize cannot write after the flip.
    const updated = await this.serializeWrite(() => this.db.transaction(async (tx) => {
      const [header] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
      if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
      if (header.status !== 'receiving') {
        throw new SubmissionError(SUBMISSION_ERROR_CODES.submissionNotReceiving, 409, `submission is '${header.status}', not receiving`);
      }

      // Range check (single status, F43) — against the in-tx expectedCount.
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
          // Validate the persisted row before comparing (F41) — a malformed stored
          // payload fails closed rather than deciding equality on untrusted JSON.
          const priorItem = this.parseStoredItemOrThrow(prior, row.ordinal);
          // Already stored — identical content is a no-op (0 bytes); conflicting content → 409.
          if (JSON.stringify(priorItem) !== JSON.stringify(row.item)) {
            throw new SubmissionError(SUBMISSION_ERROR_CODES.ordinalContentConflict, 409, `ordinal ${row.ordinal} already stored with different content`);
          }
          continue;
        }
        deltaBytes += stagedItemBytes(row.item);
        newOrdinals += 1;
        toInsert.push({ ordinal: row.ordinal, item: row.item });
      }

      // CAS-guarded increment: the cap is enforced in the WHERE clause against the
      // row's CURRENT bytes (not the pre-read snapshot), so the check and the write
      // are one atomic step. rowsAffected === 0 means the guard failed → distinguish
      // over-cap from a lost 'receiving' race and throw with no state change (the
      // inserts below never ran).
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

  /**
   * Verify every ordinal present + digest match, then CAS-flip receiving →
   * processing and nudge the runner ONLY on the winning CAS. Replay on an already-
   * finalized header is a no-op (no re-nudge).
   */
  async finalize(id: number): Promise<SubmissionResponse> {
    // Serialized on the write lane (F36) so simultaneous finalizes never overlap on the
    // shared connection; the second observes the winner's committed 'processing'
    // (idempotent replay, no re-nudge) and fulfills.
    return this.serializeWrite(() => this.finalizeOnce(id));
  }

  private async finalizeOnce(id: number): Promise<SubmissionResponse> {
    // The ordinal read, gap/digest verification, and CAS flip all run in ONE
    // transaction (F1): a concurrent PUT or stale-'receiving' cleanup cannot
    // interleave between the verification and the transition, so finalize either
    // sees a consistent snapshot and flips it, or sees the header already gone/
    // transitioned. `nudgeRunner` fires AFTER commit, only on the winning CAS.
    const { header, nudged } = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
      if (!current) throw new SubmissionError('submission-not-found', 404, 'submission not found');
      if (current.status !== 'receiving') {
        // Idempotent replay — a second finalize on processing/complete is a no-op.
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

      // Validate every persisted item before it feeds the AUTHORITATIVE digest (F41):
      // a malformed stored row fails closed here (typed error, no receiving→processing
      // transition, no nudge) rather than being hashed as untrusted JSON. (All ordinals
      // are present + non-null at finalize; a nulled payload would already fail the gap
      // check above, so any survivor is expected to parse.)
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
      // A concurrent stale-'receiving' cleanup can delete the header between this tx's
      // read and its CAS write (F27) — the update then affects 0 rows and there is no
      // record to return. Treat that as cleanup-won: a typed 404, no nudge, no crash.
      if (!after) throw new SubmissionError('submission-not-found', 404, 'submission not found');
      return { header: after, nudged: getRowsAffected(result) === 1 };
    });

    if (nudged) {
      this.log.info({ submissionId: id }, 'Staged import submission finalized — nudging runner');
      this.nudgeRunner();
    }
    return this.buildSummary(header);
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

  /**
   * Discard a still-'receiving' submission (#1894). Runs on the write lane (same
   * lane as PUT/finalize) as an ATOMIC `DELETE … WHERE id=? AND status='receiving'`
   * so it can never race a concurrent finalize: a header that finalized first fails
   * the status predicate and is never deleted. Zero rows affected → re-read the
   * header to distinguish absent (404) from non-'receiving' (409). Cascades item rows.
   */
  async discardReceiving(id: number): Promise<{ success: true }> {
    const affected = await this.serializeWrite(async () => {
      const result = await this.db
        .delete(importSubmissions)
        .where(and(eq(importSubmissions.id, id), eq(importSubmissions.status, 'receiving')));
      return getRowsAffected(result);
    });
    if (affected === 1) {
      this.log.info({ submissionId: id }, 'Staged import submission discarded');
      return { success: true };
    }
    const [header] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    throw new SubmissionError(SUBMISSION_ERROR_CODES.submissionNotReceiving, 409, `submission is '${header.status}', not receiving`);
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

  /**
   * Aggregate counts + processedCount + detailsPruned, plus item rows ONLY when
   * `loadItems` is true (F7). The summary path never selects `itemPayload` — live
   * counts come from a `disposition`-only projection fed through the shared
   * `aggregateDispositions` (F13), and `detailsPruned` uses a `limit 1` existence
   * probe — so a cheap progress poll of a 10 000-row submission never transfers or
   * parses the stored detail JSON.
   */
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
      // Frozen aggregate columns survive item pruning (the durable record). The
      // progress/pruning DECISION lives once in the pure DTO layer (F6).
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

    // Live counts during receiving/processing (0 during receiving) from a
    // disposition-only projection — no itemPayload transfer.
    const dispositionRows = await this.db
      .select({ disposition: importSubmissionItems.disposition })
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, header.id));
    return { ...liveProgress(dispositionRows.map((r) => r.disposition as ItemDisposition)), itemRows };
  }

  private headerFields(header: SubmissionRow, progress: Awaited<ReturnType<ImportStagingService['computeProgress']>>) {
    // Canonical header assembly lives once in the pure DTO module (F82/F85).
    return buildHeaderFields(header, progress);
  }

  private async buildSummary(header: SubmissionRow): Promise<SubmissionResponse> {
    const progress = await this.computeProgress(header, false);
    return { ...this.headerFields(header, progress), itemsIncluded: false };
  }

  private async buildDetail(header: SubmissionRow): Promise<SubmissionResponse> {
    const progress = await this.computeProgress(header, true);
    // Detail + pruned → the summary arm (aggregates-only permanent record).
    if (progress.detailsPruned) {
      return { ...this.headerFields(header, progress), itemsIncluded: false };
    }
    const items = progress.itemRows.map((row) => this.toItemDto(row));
    return { ...this.headerFields(header, progress), itemsIncluded: true, items };
  }

  /**
   * Project a persisted accepted `itemPayload` at the detail read boundary (F5/F50) —
   * SQLite does not enforce Drizzle's compile-time `$type`, so a stored blob is
   * untrusted. Three-state so the accepted DTO can distinguish the cases without ever
   * leaking an unvalidated shape:
   *  - `undefined` → payload was intentionally nulled at disposition (omit `item`);
   *  - `null`      → payload present but MALFORMED (project `item: null`, log a warning);
   *  - object      → valid parsed item.
   */
  private projectAcceptedItem(row: ItemRow): StagedImportItem | null | undefined {
    if (row.itemPayload == null) return undefined;
    const parsed = stagedImportItemSchema.safeParse(row.itemPayload);
    if (!parsed.success) {
      this.log.warn({ submissionId: row.submissionId, ordinal: row.ordinal }, 'Persisted staged item failed validation on read');
      return null;
    }
    return parsed.data;
  }

  /**
   * Parse a persisted `itemPayload` at a MUTATION read boundary (F41) — the re-PUT
   * content-equality check and the authoritative finalize digest both consume stored
   * JSON, which SQLite does not validate against Drizzle's compile-time `$type`. A
   * malformed persisted row must NOT silently participate in an equality/digest
   * decision, so we fail closed with a typed error and no state transition/nudge.
   */
  private parseStoredItemOrThrow(payload: unknown, ordinal: number): StagedImportItem {
    const parsed = stagedImportItemSchema.safeParse(payload);
    if (!parsed.success) {
      this.log.warn({ ordinal }, 'Persisted staged item failed validation at a mutation read boundary');
      throw new SubmissionError(SUBMISSION_ERROR_CODES.itemInvalid, 422, `persisted staged item at ordinal ${ordinal} failed validation`);
    }
    return parsed.data;
  }

  private toItemDto(row: ItemRow): StagedItemResultDto {
    // Accepted is the ONLY staging-specific arm — it validates + projects the stored
    // `itemPayload`. Every other arm (held/skipped/failed/pending) shares the canonical
    // projected-row mapper so the two DTO paths cannot drift (F7).
    if (row.disposition === 'accepted') {
      const item = this.projectAcceptedItem(row);
      // `undefined` → omit (payload nulled); `null` → explicit malformed signal; object → valid.
      return { disposition: 'accepted', ordinal: row.ordinal, path: row.path, title: row.title, bookId: row.bookId, ...(item !== undefined ? { item } : {}) };
    }
    return reportRowToDto(row);
  }
}
