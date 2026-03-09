import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Download } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useActivity() {
  const queryClient = useQueryClient();

  const { data: downloads = [], isLoading, isError } = useQuery({
    queryKey: queryKeys.activity(),
    queryFn: api.getActivity,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      return data.some((d: Download) => ['queued', 'downloading', 'checking', 'importing'].includes(d.status)) ? 5000 : false;
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

  const queue = downloads.filter((d) =>
    ['queued', 'downloading', 'paused', 'checking', 'pending_review', 'importing'].includes(d.status)
  );
  const history = downloads.filter((d) =>
    ['completed', 'imported', 'failed'].includes(d.status)
  );

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
