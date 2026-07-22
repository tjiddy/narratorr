import type { importSubmissions, importSubmissionItems } from '../../db/schema.js';
import type { ImportMode } from '../../shared/schemas/library-scan.js';
import {
  aggregateDispositions,
  type ItemDisposition,
  type StagedItemResultDto,
  type SubmissionAggregates,
  type SubmissionSource,
  type SubmissionStatus,
  type SubmissionSummary,
} from '../../core/import-staging/schemas.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

/**
 * The NORMALIZED header input the single canonical mapper consumes (#1894, F39).
 * Timestamps are already ISO strings and primitives are canonical, so both a
 * Drizzle row (`drizzleHeaderInput`) and the raw attention CTE row adapt to this
 * one shape — there is exactly one place that decides how header fields become the
 * wire summary, so the attention path can never drift from list/staging.
 */
export interface SubmissionHeaderInput {
  id: number;
  clientSubmissionId: string;
  source: SubmissionSource;
  mode: ImportMode | null;
  status: SubmissionStatus;
  expectedCount: number;
  receivedCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Adapt a Drizzle `import_submissions` row to the normalized header input (F39). */
export function drizzleHeaderInput(row: SubmissionRow): SubmissionHeaderInput {
  return {
    id: row.id,
    clientSubmissionId: row.clientSubmissionId,
    source: row.source,
    mode: row.mode ?? null,
    status: row.status as SubmissionStatus,
    expectedCount: row.expectedCount,
    receivedCount: row.receivedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * Pure DTO assembly for staged submissions (#1894, F82/F85). These mappers carry
 * the canonical progress/disposition/`detailsPruned` DECISIONS once, with no DB or
 * logger access, so both the single-record loaders in `ImportStagingService` and
 * the set-based/CTE loaders in `ImportSubmissionReportService` produce identical
 * wire shapes. The I/O that FEEDS these mappers is per-service; the mapping is not.
 */

/** Precomputed progress a caller derives (per-record I/O or set-based) then feeds in. */
export interface SubmissionProgress {
  aggregates: SubmissionAggregates;
  processedCount: number;
  detailsPruned: boolean;
}

/** The canonical processed-count decision — sum of terminal dispositions (F6). */
export function sumAggregates(a: SubmissionAggregates): number {
  return a.accepted + a.held + a.skipped + a.failed;
}

/**
 * Progress for a `complete` header (F6). The frozen aggregate columns are the
 * durable record; `detailsPruned` is the ONE canonical decision
 * `expectedCount > 0 && !hasItems` — the caller supplies the existence result it
 * already loaded (single-record probe or a set-based batch), never re-derived here.
 */
export function completeProgress(counts: SubmissionAggregates, expectedCount: number, hasItems: boolean): SubmissionProgress {
  return { aggregates: counts, processedCount: sumAggregates(counts), detailsPruned: expectedCount > 0 && !hasItems };
}

/** Progress for a non-`complete` header from already-summed live aggregates (F6). */
export function liveProgressFromAggregates(aggregates: SubmissionAggregates): SubmissionProgress {
  return { aggregates, processedCount: sumAggregates(aggregates), detailsPruned: false };
}

/** Progress for a non-`complete` header from a raw disposition list (F6). */
export function liveProgress(dispositions: readonly ItemDisposition[]): SubmissionProgress {
  return liveProgressFromAggregates(aggregateDispositions(dispositions));
}

/**
 * The SINGLE canonical header mapper (#1894, F39): normalized header input +
 * precomputed progress → the wire summary header fields. Both the Drizzle-row and
 * attention-CTE paths feed this, so optional `mode`/`completedAt` presence and
 * field assembly are decided once.
 */
export function buildHeaderFields(header: SubmissionHeaderInput, progress: SubmissionProgress) {
  return {
    id: header.id,
    clientSubmissionId: header.clientSubmissionId,
    source: header.source,
    ...(header.mode ? { mode: header.mode } : {}),
    status: header.status,
    expectedCount: header.expectedCount,
    receivedCount: header.receivedCount,
    processedCount: progress.processedCount,
    aggregates: progress.aggregates,
    detailsPruned: progress.detailsPruned,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    ...(header.completedAt ? { completedAt: header.completedAt } : {}),
  };
}

/** Drizzle header row + precomputed progress → the summary DTO (`itemsIncluded:false`). */
export function toSummaryDto(header: SubmissionRow, progress: SubmissionProgress): SubmissionSummary {
  return { ...buildHeaderFields(drizzleHeaderInput(header), progress), itemsIncluded: false } as SubmissionSummary;
}

/**
 * The projected column set the report-detail read selects (F62/F66). Deliberately
 * EXCLUDES `itemPayload` (an accepted row can carry up to a 64 MiB blob the report
 * never renders) and there is no `message` column — the failed DTO's `message` is
 * derived from `reason`. A regression guard asserts this set.
 */
export const REPORT_ITEM_COLUMNS = [
  'disposition',
  'ordinal',
  'path',
  'title',
  'reason',
  'existingBookId',
  'existingTitle',
  'bookId',
] as const;

/** A projected report row — exactly the columns in `REPORT_ITEM_COLUMNS`. */
export type ReportItemRow = Pick<ItemRow, (typeof REPORT_ITEM_COLUMNS)[number]>;

/**
 * Report-row projection mapper (F62/F66). A SEPARATE mapper from the full-row
 * `toItemDto` because its input shape differs: it never carries `itemPayload`, so
 * the accepted arm omits `item` (the report/panel render accepted as a count/book
 * link, never the staged payload) and the failed arm derives `message` from
 * `reason`. It shares only the genuinely-identical disposition semantics.
 */
export function reportRowToDto(row: ReportItemRow): StagedItemResultDto {
  const base = { ordinal: row.ordinal, path: row.path, title: row.title };
  switch (row.disposition) {
    case 'accepted':
      // Accepted `item` is intentionally omitted — the report shows a count/book link.
      return { disposition: 'accepted', ...base, bookId: row.bookId };
    case 'held':
      return {
        disposition: 'held',
        ...base,
        reason: 'recording-review-required',
        ...(row.existingBookId != null ? { existingBookId: row.existingBookId } : {}),
      };
    case 'skipped':
      return {
        disposition: 'skipped',
        ...base,
        reason: row.reason === 'already-importing' ? 'already-importing' : 'already-in-library',
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
