import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

/**
 * Convert a report-detail response to a header-only list summary (#1894, F8). One
 * home for the decision of which fields enter the canonical list header — used by
 * both the Activity deep-link hydration and the list cache patch, so a hydrated
 * card and a cache-patched card can never disagree on the header shape. Strips
 * `items` and forces the summary arm (`itemsIncluded:false`).
 */
export function detailToSummary(detail: SubmissionResponse): SubmissionSummary {
  const { items: _items, ...rest } = detail as SubmissionResponse & { items?: unknown };
  return { ...rest, itemsIncluded: false } as SubmissionSummary;
}
