import { useQuery, useQueryClient } from '@tanstack/react-query';
import { submissionResponseSchema } from '@core/import-staging/schemas.js';
import { api, ApiError, type AttentionResponse, type SubmissionResponse, type SubmissionSummary } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { pollCadence, FAST_POLL_MS } from '@/lib/import-report/polling';
import { patchImportHistoryCache } from '@/lib/import-report/cache';

type ImportSource = 'library' | 'manual';

/** Polls quickly while the latest import is active, then at baseline to discover a new run. */
export function useLatestImport(source: ImportSource) {
  return useQuery<SubmissionSummary | null>({
    queryKey: queryKeys.importSubmissions.latest(source),
    queryFn: async () => {
      const res = await api.listImportSubmissions({ source, limit: 1 });
      return res.data[0] ?? null;
    },
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 2,
    placeholderData: (prev) => prev,
    refetchInterval: (query) => {
      const d = query.state.data;
      return pollCadence(d != null && d.status !== 'complete');
    },
  });
}

/** Polls quickly while `watch` is true, then at baseline to discover later attention states. */
export function useImportAttention(source?: ImportSource) {
  return useQuery<AttentionResponse>({
    queryKey: queryKeys.importSubmissions.attention(source),
    queryFn: () => api.getImportSubmissionAttention(source ? { source } : undefined),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 2,
    placeholderData: (prev) => prev,
    refetchInterval: (query) => pollCadence(query.state.data?.watch === true),
  });
}

/** A fixed report stops polling once complete and refreshes its cached history summary. */
export function useImportSubmissionDetail(id: number | null, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery<SubmissionResponse>({
    queryKey: queryKeys.importSubmissions.detail(id ?? -1),
    queryFn: async () => {
      const detail = await api.getImportSubmissionDetail(id!);
      // Validate before any cache side effect so malformed detail cannot poison cached list pages.
      if (submissionResponseSchema.safeParse(detail).success) {
        patchImportHistoryCache(queryClient, detail);
      }
      return detail;
    },
    enabled: id != null && enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    // A deep-linked 404 is gone; transient errors retry twice.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
    // Never show the previous report under a newly selected id.
    placeholderData: (prev) => (prev != null && prev.id === id ? prev : undefined),
    refetchInterval: (query) => (query.state.data?.status === 'complete' ? false : FAST_POLL_MS),
  });
}
