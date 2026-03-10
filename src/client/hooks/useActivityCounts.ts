import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useSSEConnected } from '@/hooks/useEventSource';

export function useActivityCounts() {
  const sseConnected = useSSEConnected();

  const query = useQuery({
    queryKey: queryKeys.activityCounts(),
    queryFn: api.getActivityCounts,
    refetchInterval: sseConnected ? false : 30_000,
  });

  return {
    active: query.data?.active ?? 0,
    completed: query.data?.completed ?? 0,
    isLoading: query.isLoading,
  };
}
