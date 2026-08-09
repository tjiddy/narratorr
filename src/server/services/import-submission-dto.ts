import type { importSubmissions, importSubmissionItems } from '@db/schema.js';
import type { ImportMode } from '@shared/schemas/library-scan.js';
import {
  aggregateDispositions,
  type ItemDisposition,
  type StagedItemResultDto,
  type SubmissionAggregates,
  type SubmissionSource,
  type SubmissionStatus,
  type SubmissionSummary,
} from '@core/import-staging/schemas.js';

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

/** Normalized header shared by Drizzle and raw attention-query paths; timestamps are ISO strings. */
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

// Keep mapping pure so staging and report loaders produce identical wire shapes.
export interface SubmissionProgress {
  aggregates: SubmissionAggregates;
  processedCount: number;
  detailsPruned: boolean;
}

export function sumAggregates(a: SubmissionAggregates): number {
  return a.accepted + a.held + a.skipped + a.failed;
}

/** Complete progress uses frozen aggregates; detailsPruned means expected items no longer exist. */
export function completeProgress(counts: SubmissionAggregates, expectedCount: number, hasItems: boolean): SubmissionProgress {
  return { aggregates: counts, processedCount: sumAggregates(counts), detailsPruned: expectedCount > 0 && !hasItems };
}

export function liveProgressFromAggregates(aggregates: SubmissionAggregates): SubmissionProgress {
  return { aggregates, processedCount: sumAggregates(aggregates), detailsPruned: false };
}

export function liveProgress(dispositions: readonly ItemDisposition[]): SubmissionProgress {
  return liveProgressFromAggregates(aggregateDispositions(dispositions));
}

/** Canonical wire-header assembly for both Drizzle and attention-query inputs. */
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

export function toSummaryDto(header: SubmissionRow, progress: SubmissionProgress): SubmissionSummary {
  return { ...buildHeaderFields(drizzleHeaderInput(header), progress), itemsIncluded: false } as SubmissionSummary;
}

/** Report projection excludes itemPayload, which can be 64 MiB and is never rendered. */
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

export type ReportItemRow = Pick<ItemRow, (typeof REPORT_ITEM_COLUMNS)[number]>;

/** Map projected rows without accepted payloads; derive failed messages from reason. */
export function reportRowToDto(row: ReportItemRow): StagedItemResultDto {
  const base = { ordinal: row.ordinal, path: row.path, title: row.title };
  switch (row.disposition) {
    case 'accepted':
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
