import { eq, asc, desc, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { ImportMode } from '../../shared/schemas/library-scan.js';
import { importSubmissions, importSubmissionItems } from '../../db/schema.js';
import {
  type AttentionResponse,
  type AttentionSubmission,
  type ItemDisposition,
  type SubmissionAggregates,
  type SubmissionAttention,
  type SubmissionAttentionQuery,
  type SubmissionListQuery,
  type SubmissionListResponse,
  type SubmissionResponse,
  type SubmissionSource,
  type SubmissionStatus,
} from '../../core/import-staging/schemas.js';
import { ABANDONED_UPLOAD_GRACE_MS, SubmissionError } from './import-staging.service.js';
import {
  buildHeaderFields,
  completeProgress,
  liveProgress,
  liveProgressFromAggregates,
  reportRowToDto,
  toSummaryDto,
  type ReportItemRow,
  type SubmissionProgress,
} from './import-submission-dto.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;

/**
 * The exact projected column set the report-detail read selects (F62/F66). The
 * KEYS mirror `REPORT_ITEM_COLUMNS`; a regression guard asserts `itemPayload` is
 * absent so a report expansion of an accepted row can never transfer its (up to
 * 64 MiB) staged payload. A FUNCTION (not a module-level const) so it does not
 * dereference schema columns at import time — that would break the suites that
 * partially mock `db/schema`.
 */
export function reportItemProjection() {
  return {
    disposition: importSubmissionItems.disposition,
    ordinal: importSubmissionItems.ordinal,
    path: importSubmissionItems.path,
    title: importSubmissionItems.title,
    reason: importSubmissionItems.reason,
    existingBookId: importSubmissionItems.existingBookId,
    existingTitle: importSubmissionItems.existingTitle,
    bookId: importSubmissionItems.bookId,
  } as const;
}

/** One raw row of the atomic attention CTE (columns aliased to camelCase). */
interface AttentionQueryRow {
  id: number | null;
  clientSubmissionId: string | null;
  source: string | null;
  mode: string | null;
  status: string | null;
  expectedCount: number | null;
  receivedCount: number | null;
  acceptedCount: number | null;
  heldCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  watch: number;
  hasItems: number;
}

const emptyAggregates = (): SubmissionAggregates => ({ accepted: 0, held: 0, skipped: 0, failed: 0 });

/**
 * Read-side over the #1893 staged-submission substrate (#1894). Owns the list,
 * the atomic attention snapshot (one CTE, one captured cutoff), and the
 * report-detail projection (no `itemPayload`). All assembly flows through the
 * shared pure DTO mappers so summaries here are byte-identical to the mutation
 * path's. Mutations + the receiving-only DELETE stay on `ImportStagingService`.
 */
export class ImportSubmissionReportService {
  constructor(private readonly db: Db) {}

  /**
   * Paginated durable-record list, newest-first (`createdAt DESC, id DESC`). Set-
   * based (F84): NEVER the per-record progress loader. `complete` rows use their
   * frozen aggregate columns; the (rare) non-`complete` rows on a page get live
   * counts from ONE grouped disposition query; `detailsPruned` for `complete` rows
   * comes from ONE batch existence query. At most those two item-table queries per
   * page (each skipped when its id set is empty).
   */
  async list(query: SubmissionListQuery): Promise<SubmissionListResponse> {
    const where = query.source ? eq(importSubmissions.source, query.source) : undefined;
    const totalRows = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(importSubmissions)
      .where(where);
    const total = Number(totalRows[0]?.total ?? 0);
    const headers = await this.db
      .select()
      .from(importSubmissions)
      .where(where)
      .orderBy(desc(importSubmissions.createdAt), desc(importSubmissions.id))
      .limit(query.limit)
      .offset(query.offset);
    if (headers.length === 0) return { data: [], total };

    const progressById = await this.loadPageProgress(headers);
    const data = headers.map((h) => toSummaryDto(h, progressById.get(h.id)!));
    return { data, total };
  }

  /** Set-based progress for a page of headers — the two-batch-query loader (F52/F84). */
  private async loadPageProgress(headers: SubmissionRow[]): Promise<Map<number, SubmissionProgress>> {
    const completeIds = headers.filter((h) => h.status === 'complete').map((h) => h.id);
    const liveIds = headers.filter((h) => h.status !== 'complete').map((h) => h.id);

    // Batch 1 — grouped disposition counts for the non-complete rows only.
    const liveAgg = new Map<number, SubmissionAggregates>(liveIds.map((id) => [id, emptyAggregates()]));
    if (liveIds.length > 0) {
      const counts = await this.db
        .select({
          submissionId: importSubmissionItems.submissionId,
          disposition: importSubmissionItems.disposition,
          c: sql<number>`count(*)`,
        })
        .from(importSubmissionItems)
        .where(inArray(importSubmissionItems.submissionId, liveIds))
        .groupBy(importSubmissionItems.submissionId, importSubmissionItems.disposition);
      for (const r of counts) {
        const agg = liveAgg.get(r.submissionId);
        if (!agg) continue;
        const d = r.disposition as ItemDisposition;
        if (d === 'accepted') agg.accepted += Number(r.c);
        else if (d === 'held') agg.held += Number(r.c);
        else if (d === 'skipped') agg.skipped += Number(r.c);
        else if (d === 'failed') agg.failed += Number(r.c);
      }
    }

    // Batch 2 — existence probe (DISTINCT) for the complete rows' pruning flag.
    const hasItems = new Set<number>();
    if (completeIds.length > 0) {
      const withItems = await this.db
        .selectDistinct({ submissionId: importSubmissionItems.submissionId })
        .from(importSubmissionItems)
        .where(inArray(importSubmissionItems.submissionId, completeIds));
      for (const r of withItems) hasItems.add(r.submissionId);
    }

    const map = new Map<number, SubmissionProgress>();
    for (const h of headers) {
      if (h.status === 'complete') {
        const counts: SubmissionAggregates = { accepted: h.acceptedCount, held: h.heldCount, skipped: h.skippedCount, failed: h.failedCount };
        map.set(h.id, completeProgress(counts, h.expectedCount, hasItems.has(h.id)));
      } else {
        map.set(h.id, liveProgressFromAggregates(liveAgg.get(h.id) ?? emptyAggregates()));
      }
    }
    return map;
  }

  /**
   * Attention read (F60/F68/F71). ONE atomic CTE with ONE captured cutoff computes
   * both `data` (the single newest attention-worthy submission in scope, or null)
   * and `watch` (any non-terminal row in scope). Because it is one statement,
   * `{data:null, watch:false}` is reachable ONLY when no attention-worthy and no
   * non-terminal row genuinely exists.
   */
  async attention(query: SubmissionAttentionQuery): Promise<AttentionResponse> {
    const source: string | null = query.source ?? null;
    // `updated_at` is stored as unixepoch SECONDS; strict `<` (F61).
    const cutoffSeconds = Math.floor((Date.now() - ABANDONED_UPLOAD_GRACE_MS) / 1000);
    const rows = await this.db.all<AttentionQueryRow>(sql`
      WITH scoped AS (
        SELECT * FROM import_submissions
        WHERE (${source} IS NULL OR source = ${source})
      ),
      attn AS (
        SELECT * FROM scoped
        WHERE (status = 'receiving' AND updated_at < ${cutoffSeconds})
           OR (status = 'complete' AND (held_count > 0 OR failed_count > 0))
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      SELECT
        a.id AS id,
        a.client_submission_id AS clientSubmissionId,
        a.source AS source,
        a.mode AS mode,
        a.status AS status,
        a.expected_count AS expectedCount,
        a.received_count AS receivedCount,
        a.accepted_count AS acceptedCount,
        a.held_count AS heldCount,
        a.skipped_count AS skippedCount,
        a.failed_count AS failedCount,
        a.created_at AS createdAt,
        a.updated_at AS updatedAt,
        a.completed_at AS completedAt,
        (SELECT CASE WHEN EXISTS(SELECT 1 FROM scoped WHERE status IN ('receiving', 'processing')) THEN 1 ELSE 0 END) AS watch,
        (SELECT CASE WHEN EXISTS(SELECT 1 FROM import_submission_items i WHERE i.submission_id = a.id) THEN 1 ELSE 0 END) AS hasItems
      FROM (SELECT 1) dummy
      LEFT JOIN attn a ON 1 = 1
    `);

    const row = rows[0];
    const watch = !!row && Number(row.watch) === 1;
    if (!row || row.id == null) return { data: null, watch };
    return { data: this.attentionRowToDto(row), watch };
  }

  private attentionRowToDto(row: AttentionQueryRow): AttentionSubmission {
    const toIso = (s: number) => new Date(s * 1000).toISOString();
    const isComplete = row.status === 'complete';
    // Progress/pruning DECISIONS come from the shared pure builders (F6).
    const counts: SubmissionAggregates = {
      accepted: Number(row.acceptedCount),
      held: Number(row.heldCount),
      skipped: Number(row.skippedCount),
      failed: Number(row.failedCount),
    };
    const progress = isComplete
      ? completeProgress(counts, Number(row.expectedCount), Number(row.hasItems) === 1)
      : liveProgressFromAggregates(emptyAggregates());
    const attention: SubmissionAttention = isComplete
      ? { kind: 'completed-attention', held: progress.aggregates.held, failed: progress.aggregates.failed }
      : { kind: 'abandoned' };
    return {
      id: Number(row.id),
      clientSubmissionId: row.clientSubmissionId!,
      source: row.source as SubmissionSource,
      ...(row.mode ? { mode: row.mode as ImportMode } : {}),
      status: row.status as SubmissionStatus,
      expectedCount: Number(row.expectedCount),
      receivedCount: Number(row.receivedCount),
      processedCount: progress.processedCount,
      aggregates: progress.aggregates,
      detailsPruned: progress.detailsPruned,
      itemsIncluded: false,
      createdAt: toIso(Number(row.createdAt)),
      updatedAt: toIso(Number(row.updatedAt)),
      ...(row.completedAt != null ? { completedAt: toIso(Number(row.completedAt)) } : {}),
      attention,
    };
  }

  /**
   * Report-detail projection (F62/F66/F87) — the by-id `includeItems=true` read.
   * Selects ONLY the projected columns (no `itemPayload`), maps each row through
   * the report-row mapper (accepted `item` omitted, failed `message` from
   * `reason`), and collapses a pruned record to the summary arm.
   */
  async reportDetail(id: number): Promise<SubmissionResponse> {
    const [header] = await this.db.select().from(importSubmissions).where(eq(importSubmissions.id, id)).limit(1);
    if (!header) throw new SubmissionError('submission-not-found', 404, 'submission not found');
    const progress = await this.recordProgress(header);
    if (progress.detailsPruned) {
      return { ...buildHeaderFields(header, progress), itemsIncluded: false };
    }
    const rows = await this.db
      .select(reportItemProjection())
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, id))
      .orderBy(asc(importSubmissionItems.ordinal));
    const items = (rows as ReportItemRow[]).map(reportRowToDto);
    return { ...buildHeaderFields(header, progress), itemsIncluded: true, items };
  }

  /** Single-record progress for report-detail — the shared pure builders decide (F6). */
  private async recordProgress(header: SubmissionRow): Promise<SubmissionProgress> {
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
      return completeProgress(counts, header.expectedCount, !!anyItem);
    }
    const dispositionRows = await this.db
      .select({ disposition: importSubmissionItems.disposition })
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, header.id));
    return liveProgress(dispositionRows.map((r) => r.disposition as ItemDisposition));
  }
}
