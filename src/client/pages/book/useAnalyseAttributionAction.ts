import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

/**
 * Focused hook for the manual "Analyse with earwitness" book action (#1528).
 * Kept out of `useBookActions` so that broad hook does not grow another mutation
 * + return value (REACT-1). The action's only visible output is a book event, so
 * success invalidates the event-history queries (not the book queries).
 */
export function useAnalyseAttributionAction(bookId: number) {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const analyseAttributionMutation = useMutation({
    mutationFn: () => api.analyseBookAttribution(bookId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.byBookId(bookId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
      toast.success('Recorded earwitness analysis — see the History tab');
    },
    onError: (error: Error) => {
      toast.error(`Earwitness analysis failed: ${getErrorMessage(error)}`);
    },
  });

  return {
    analyseAttributionMutation,
    earwitnessEnabled: !!settings?.earwitness?.enabled,
  };
}
