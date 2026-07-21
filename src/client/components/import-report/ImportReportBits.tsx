import type { SubmissionAggregates, SubmissionSummary } from '@/lib/api';
import { STATUS_LABELS } from '@/lib/import-report/rowDisplay';

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
