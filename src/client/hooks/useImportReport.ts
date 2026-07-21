import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AttentionResponse, type SubmissionResponse, type SubmissionSummary } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { pollCadence, FAST_POLL_MS } from '@/lib/import-report/polling';
import { patchImportHistoryCache } from '@/lib/import-report/cache';

type ImportSource = 'library' | 'manual';

/**
 * Last-import panel feed (#1894). The "latest" read is the list with `limit=1` +
 * `source`; the client consumes `data[0] ?? null`. Fresh on mount
 * (`refetchOnMount:'always'` over cache), retains last-good on error, and polls at
 * the two-tier cadence — fast while the latest submission is non-`complete`,
 * baseline (never stopped) once complete/absent so it discovers the next run.
 */
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

/**
 * Attention-banner feed (#1894). Server-authoritative: the client renders
 * `data.attention.kind` and drives its poll cadence off `watch` — fast while any
 * non-terminal submission exists, baseline (never stopped) otherwise, so an
 * attention state that arises later (another tab, a boot-resume completion) is
 * discovered without a remount. Retains last-good on error (a failed read is
 * observable/retryable, never silently "no banner").
 */
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

/**
 * Id-scoped report-detail feed shared by BOTH expansion surfaces (panel +
 * Activity), self-polling off its OWN returned `status` (#1894, F74/F81): fast
 * while non-`complete`, then STOPS at `complete` (a fixed run's terminal detail is
 * immutable — unlike the latest/attention reads there is no new run to discover on
 * a fixed id). On each response it promotes the freshened header back into the
 * list cache (F86/F89) so an Activity card's header never reverts on collapse.
 */
export function useImportSubmissionDetail(id: number | null, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery<SubmissionResponse>({
    queryKey: queryKeys.importSubmissions.detail(id ?? -1),
    queryFn: async () => {
      const detail = await api.getImportSubmissionDetail(id!);
      patchImportHistoryCache(queryClient, detail);
      return detail;
    },
    enabled: id != null && enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: 2,
    placeholderData: (prev) => prev,
    refetchInterval: (query) => (query.state.data?.status === 'complete' ? false : FAST_POLL_MS),
  });
}
