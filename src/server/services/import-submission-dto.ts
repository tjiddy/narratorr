import type { importSubmissions, importSubmissionItems } from '../../db/schema.js';
import type {
  StagedItemResultDto,
  SubmissionAggregates,
  SubmissionStatus,
  SubmissionSummary,
} from '../../core/import-staging/schemas.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

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

/** header row + precomputed progress → the canonical summary header field object. */
export function buildHeaderFields(header: SubmissionRow, progress: SubmissionProgress) {
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

/** header row + precomputed progress → the summary DTO (`itemsIncluded:false`). */
export function toSummaryDto(header: SubmissionRow, progress: SubmissionProgress): SubmissionSummary {
  return { ...buildHeaderFields(header, progress), itemsIncluded: false } as SubmissionSummary;
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
