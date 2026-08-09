import { formatRelativeDate } from '@/lib/format';
import type { SubmissionSummary } from '@/lib/api';

export const STATUS_LABELS = {
  receiving: 'Receiving',
  processing: 'Processing',
  complete: 'Completed',
} as const;

/** Complete rows age from `completedAt`; all others age from `createdAt`. */
export function relativeWhen(row: SubmissionSummary): string {
  const when = row.status === 'complete' ? row.completedAt ?? row.createdAt : row.createdAt;
  return formatRelativeDate(when);
}
