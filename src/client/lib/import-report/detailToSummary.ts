import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

/** Drops detail rows and normalizes the response to the canonical list-header shape. */
export function detailToSummary(detail: SubmissionResponse): SubmissionSummary {
  const { items: _items, ...rest } = detail as SubmissionResponse & { items?: unknown };
  return { ...rest, itemsIncluded: false } as SubmissionSummary;
}
