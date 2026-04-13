import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Download, type ActivityListParams } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useSSEConnected } from '@/hooks/useEventSource';
import { isInProgressStatus } from '../../../shared/download-status-registry.js';

export function useActivity(queueParams: ActivityListParams = {}) {
  const queryClient = useQueryClient();
  const sseConnected = useSSEConnected();

  const fullParams = { ...queueParams, section: 'queue' as const };
  const queueQuery = useQuery({
    queryKey: queryKeys.activity(fullParams),
    queryFn: () => api.getActivity(fullParams),
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) => {
      if (sseConnected) return false;
      const raw = query.state.data;
      if (!raw) return 5000;
      return raw.data.some((d: Download) => isInProgressStatus(d.status)) ? 5000 : false;
    },
  });

  const queue = queueQuery.data?.data ?? [];
  const queueTotal = queueQuery.data?.total ?? 0;

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
    mutationFn: ({ id, retry }: { id: number; retry?: boolean }) => api.rejectDownload(id, { retry }),
    onSuccess: invalidateActivity,
  });

  return {
    state: {
      queue,
      queueTotal,
    },
    status: {
      isLoading: queueQuery.isLoading,
      isError: queueQuery.isError,
    },
    mutations: {
      cancelMutation,
      retryMutation,
      approveMutation,
      rejectMutation,
    },
  };
}
