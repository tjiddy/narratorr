import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Download } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { isInProgressStatus, isTerminalStatus } from '../../../shared/download-status-registry.js';
import { useSSEConnected } from '@/hooks/useEventSource';

export function useActivity() {
  const queryClient = useQueryClient();
  const sseConnected = useSSEConnected();

  const { data: downloads = [], isLoading, isError } = useQuery({
    queryKey: queryKeys.activity(),
    queryFn: () => api.getActivity(),
    select: (response) => response.data,
    refetchInterval: (query) => {
      if (sseConnected) return false; // SSE handles real-time updates
      const raw = query.state.data;
      if (!raw) return 5000;
      const items = raw.data;
      return items.some((d: Download) => isInProgressStatus(d.status)) ? 5000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: api.cancelDownload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const retryMutation = useMutation({
    mutationFn: api.retryDownload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const approveMutation = useMutation({
    mutationFn: api.approveDownload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => api.rejectDownload(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const queue = downloads.filter((d) => isInProgressStatus(d.status));
  const history = downloads.filter((d) => isTerminalStatus(d.status));

  return {
    downloads,
    queue,
    history,
    isLoading,
    isError,
    cancelMutation,
    retryMutation,
    approveMutation,
    rejectMutation,
  };
}
