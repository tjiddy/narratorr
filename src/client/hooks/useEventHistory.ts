import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type EventHistoryParams } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useEventHistory(params?: EventHistoryParams) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.eventHistory.all(params),
    queryFn: () => api.getEventHistory(params),
    placeholderData: (previousData: unknown) => previousData,
  });

  const events = query.data?.data ?? [];
  const total = query.data?.total ?? 0;

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

  const deleteMutation = useMutation({
    mutationFn: api.deleteEvent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      toast.success('Event deleted');
    },
    onError: (error: Error) => {
      toast.error(`Delete failed: ${error.message}`);
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: api.deleteEvents,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      const label = variables?.eventType ? 'matching events' : 'all events';
      toast.success(`Cleared ${label}`);
    },
    onError: (error: Error) => {
      toast.error(`Clear failed: ${error.message}`);
    },
  });

  return { events, total, isLoading: query.isLoading, isError: query.isError, markFailedMutation, deleteMutation, bulkDeleteMutation };
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

  const deleteMutation = useMutation({
    mutationFn: api.deleteEvent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.byBookId(bookId) });
      toast.success('Event deleted');
    },
    onError: (error: Error) => {
      toast.error(`Delete failed: ${error.message}`);
    },
  });

  return { events, isLoading, isError, markFailedMutation, deleteMutation };
}
