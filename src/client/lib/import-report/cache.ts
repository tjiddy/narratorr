import type { QueryClient } from '@tanstack/react-query';
import type { SubmissionListResponse, SubmissionResponse, SubmissionSummary } from '@/lib/api';
import { detailToSummary } from './detailToSummary';

/**
 * Cache patch that promotes a self-polled report-detail's canonical header back
 * into the Activity import-history list cache (#1894, F83/F86/F89).
 *
 * A card must have ONE source of truth for its header in every state. When a
 * detail poll for an id reaches a newer/more-terminal state than the list-cache
 * entry, we write the detail's HEADER FIELDS (rows stay in the detail query) into
 * the list cache for that id — so the card header renders from the freshened
 * summary whether expanded, collapsed, or re-expanded, and never reverts to a
 * stale `Processing` snapshot on collapse.
 *
 * Mirrors the existing `patchActivityProgress` prior art (`useEventSource.ts`):
 * scans EVERY cached `['importSubmissions','list']` page (paginated keys) and
 * shape-guards each envelope, so an id present on more than one cached page is
 * patched everywhere (F89).
 */

const STATUS_ORDER = { receiving: 0, processing: 1, complete: 2 } as const;

/** Detail is "more terminal" than the cached row: a status advance, or more processed. */
function isMoreTerminal(detail: SubmissionSummary, existing: SubmissionSummary): boolean {
  const d = STATUS_ORDER[detail.status];
  const e = STATUS_ORDER[existing.status];
  if (d !== e) return d > e;
  return detail.processedCount > existing.processedCount;
}

export function patchImportHistoryCache(queryClient: QueryClient, detail: SubmissionResponse): void {
  const header = detailToSummary(detail);
  const queries = queryClient.getQueryCache().findAll({ queryKey: ['importSubmissions', 'list'] });
  for (const query of queries) {
    const cached = query.state.data as SubmissionListResponse | undefined;
    if (!cached || !Array.isArray(cached.data)) continue;
    if (!cached.data.some((row) => row.id === header.id)) continue;
    queryClient.setQueryData<SubmissionListResponse>(query.queryKey, (old) => {
      if (!old?.data) return old;
      return {
        ...old,
        data: old.data.map((row) => (row.id === header.id && isMoreTerminal(header, row) ? header : row)),
      };
    });
  }
}
