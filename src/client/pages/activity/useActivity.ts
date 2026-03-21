import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
    onSuccess: ({ bookId }) => {
      invalidateActivity();
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      if (bookId != null) {
        queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.byBookId(bookId) });
      }
    },
  });

  const deleteHistoryMutation = useMutation({
    mutationFn: api.deleteDownloadHistory,
    onSuccess: () => {
      invalidateActivity();
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
    },
  });

  return {
    queue, queueTotal,
    history, historyTotal,
    isLoading: queueQuery.isLoading || historyQuery.isLoading,
    isError: queueQuery.isError || historyQuery.isError,
    cancelMutation,
    retryMutation,
    approveMutation,
    rejectMutation,
    deleteMutation,
    deleteHistoryMutation,
  };
}
