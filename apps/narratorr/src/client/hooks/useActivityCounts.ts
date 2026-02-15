import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useActivityCounts() {
  const query = useQuery({
    queryKey: queryKeys.activityCounts(),
    queryFn: api.getActivityCounts,
    refetchInterval: 30_000,
  });

  return {
    active: query.data?.active ?? 0,
    completed: query.data?.completed ?? 0,
    isLoading: query.isLoading,
  };
}
