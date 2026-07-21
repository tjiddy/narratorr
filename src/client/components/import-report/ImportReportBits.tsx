import { formatRelativeDate } from '@/lib/format';
import type { SubmissionAggregates, SubmissionSummary } from '@/lib/api';

/** Status label mapping — one home (F58). */
export const STATUS_LABELS = {
  receiving: 'Receiving',
  processing: 'Processing',
  complete: 'Completed',
} as const;

const STATUS_CLASSES = {
  receiving: 'bg-blue-500/15 text-blue-500',
  processing: 'bg-amber-500/15 text-amber-500',
  complete: 'bg-emerald-500/15 text-emerald-500',
} as const;

export function StatusChip({ status }: { status: SubmissionSummary['status'] }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASSES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Relative time source (F47/F58): `completedAt` when complete (falling back to
 * `createdAt` if a complete header somehow lacks it), else `createdAt`. Malformed
 * values surface `formatRelativeDate`'s own `'Invalid Date'` fallback.
 */
export function relativeWhen(row: SubmissionSummary): string {
  const when = row.status === 'complete' ? row.completedAt ?? row.createdAt : row.createdAt;
  return formatRelativeDate(when);
}

/** Accepted is shown as "queued"; the attention counts follow. */
export function DispositionCounts({ aggregates }: { aggregates: SubmissionAggregates }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      <span>{aggregates.accepted} queued</span>
      <span>{aggregates.held} held</span>
      <span>{aggregates.skipped} skipped</span>
      <span>{aggregates.failed} failed</span>
    </span>
  );
}
