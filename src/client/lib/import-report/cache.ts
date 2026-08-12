import type { QueryClient } from '@tanstack/react-query';
import type { SubmissionListResponse, SubmissionResponse, SubmissionSummary } from '@/lib/api';
import { detailToSummary } from './detailToSummary';

/** Promotes a newer detail header into every cached page so collapse cannot restore stale status. */

const STATUS_ORDER = { receiving: 0, processing: 1, complete: 2 } as const;

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
    // Skip no-op writes: a new cache reference can retrigger the list-arrival patch loop.
    if (!cached.data.some((row) => row.id === header.id && isMoreTerminal(header, row))) continue;
    queryClient.setQueryData<SubmissionListResponse>(query.queryKey, (old) => {
      if (!old?.data) return old;
      return {
        ...old,
        data: old.data.map((row) => (row.id === header.id && isMoreTerminal(header, row) ? header : row)),
      };
    });
  }
}
