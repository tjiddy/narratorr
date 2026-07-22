import { formatRelativeDate } from '@/lib/format';
import type { SubmissionSummary } from '@/lib/api';

/** Status label mapping — one home (F58). */
export const STATUS_LABELS = {
  receiving: 'Receiving',
  processing: 'Processing',
  complete: 'Completed',
} as const;

/**
 * Relative time source (F47/F58): `completedAt` when complete (falling back to
 * `createdAt` if a complete header somehow lacks it), else `createdAt`. Malformed
 * values surface `formatRelativeDate`'s own `'Invalid Date'` fallback.
 */
export function relativeWhen(row: SubmissionSummary): string {
  const when = row.status === 'complete' ? row.completedAt ?? row.createdAt : row.createdAt;
  return formatRelativeDate(when);
}
