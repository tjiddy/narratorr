import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useEventHistory(params?: { eventType?: string; search?: string }) {
  const queryClient = useQueryClient();

  const { data: events = [], isLoading, isError } = useQuery({
    queryKey: queryKeys.eventHistory.all(params),
    queryFn: () => api.getEventHistory(params),
  });

  const markFailedMutation = useMutation({
    mutationFn: api.markEventFailed,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      toast.success('Release blacklisted and book set to wanted');
    },
    onError: (error: Error) => {
      toast.error(`Mark as failed: ${error.message}`);
    },
  });

  return { events, isLoading, isError, markFailedMutation };
}

export function useBookEventHistory(bookId: number) {
  const queryClient = useQueryClient();

  const { data: events = [], isLoading, isError } = useQuery({
    queryKey: queryKeys.eventHistory.byBookId(bookId),
    queryFn: () => api.getBookEventHistory(bookId),
  });

  const markFailedMutation = useMutation({
    mutationFn: api.markEventFailed,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.byBookId(bookId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      toast.success('Release blacklisted and book set to wanted');
    },
    onError: (error: Error) => {
      toast.error(`Mark as failed: ${error.message}`);
    },
  });

  return { events, isLoading, isError, markFailedMutation };
}
