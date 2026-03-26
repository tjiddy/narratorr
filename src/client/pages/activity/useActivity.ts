import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Download, type ActivityListParams } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useSSEConnected } from '@/hooks/useEventSource';
import { isInProgressStatus } from '../../../shared/download-status-registry.js';

function useActivitySection(section: 'queue' | 'history', params: ActivityListParams) {
  const sseConnected = useSSEConnected();
  const fullParams = { ...params, section };

  return useQuery({
    queryKey: queryKeys.activity(fullParams),
    queryFn: () => api.getActivity(fullParams),
    // Keep previous page's data while the next page loads so the clamp useEffect
    // in ActivityPage never sees total=0 mid-navigation (which would reset the page).
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) => {
      if (section === 'history') return false;
      if (sseConnected) return false;
      const raw = query.state.data;
      if (!raw) return 5000;
      return raw.data.some((d: Download) => isInProgressStatus(d.status)) ? 5000 : false;
    },
  });
}

export function useActivity(queueParams: ActivityListParams = {}, historyParams: ActivityListParams = {}) {
  const queryClient = useQueryClient();

  const queueQuery = useActivitySection('queue', queueParams);
  const historyQuery = useActivitySection('history', historyParams);

  const queue = queueQuery.data?.data ?? [];
  const queueTotal = queueQuery.data?.total ?? 0;
  const history = historyQuery.data?.data ?? [];
  const historyTotal = historyQuery.data?.total ?? 0;

  const invalidateActivity = () => {
    queryClient.invalidateQueries({ queryKey: ['activity'] });
  };

  const cancelMutation = useMutation({
    mutationFn: api.cancelDownload,
    onSuccess: invalidateActivity,
  });

  const retryMutation = useMutation({
    mutationFn: api.retryDownload,
    onSuccess: invalidateActivity,
  });

  const approveMutation = useMutation({
    mutationFn: api.approveDownload,
    onSuccess: invalidateActivity,
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => api.rejectDownload(id),
    onSuccess: invalidateActivity,
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, bookId }: { id: number; bookId?: number | null }) =>
      api.deleteHistoryDownload(id).then((result) => ({ ...result, bookId })),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ['activity'] });
      type HistoryCache = { data: Download[]; total: number };
      const entries = queryClient.getQueriesData<HistoryCache>({ queryKey: ['activity'] });
      const snapshot: [QueryKey, HistoryCache][] = [];
      for (const [key, data] of entries) {
        if (!data) continue;
        const params = key[1] as (ActivityListParams & { section?: string }) | undefined;
        if (params?.section !== 'history') continue;
        snapshot.push([key, data]);
        queryClient.setQueryData<HistoryCache>(key, {
          data: data.data.filter((d) => d.id !== id),
          total: Math.max(0, data.total - 1),
        });
      }
      return { snapshot };
    },
    onSuccess: () => {
      toast.success('Download deleted');
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        for (const [key, data] of context.snapshot) {
          queryClient.setQueryData(key, data);
        }
      }
      toast.error('Failed to delete download');
    },
    onSettled: (_data, _err, { bookId }) => {
      invalidateActivity();
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      if (bookId != null) {
        queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.byBookId(bookId) });
      }
    },
  });

  const deleteHistoryMutation = useMutation({
    mutationFn: () => api.deleteDownloadHistory(),
    onSuccess: () => {
      invalidateActivity();
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      toast.success('Download history cleared');
    },
    onError: () => {
      toast.error('Failed to clear history');
    },
  });

  return {
    state: {
      queue,
      queueTotal,
      history,
      historyTotal,
    },
    status: {
      isLoading: queueQuery.isLoading || historyQuery.isLoading,
      isError: queueQuery.isError || historyQuery.isError,
    },
    mutations: {
      cancelMutation,
      retryMutation,
      approveMutation,
      rejectMutation,
      deleteMutation,
      deleteHistoryMutation,
    },
  };
}
