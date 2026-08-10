import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { SUBMISSION_ERROR_CODES } from '@core/import-staging/schemas.js';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

const IN_FLIGHT_COPY = 'This run is still importing — you can delete it once it finishes.';

function isInFlight(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.body as { error?: string } | null)?.error === SUBMISSION_ERROR_CODES.submissionInFlight
  );
}

function clearedCopy(deleted: number): string {
  if (deleted === 0) return 'No completed runs to clear';
  return `Cleared ${deleted} completed import run${deleted === 1 ? '' : 's'}`;
}

/**
 * Owns both delete mutations at section scope so their callbacks cannot fire against an
 * unmounted row. `runId` is the currently deep-linked run, which the shared cleanup rule
 * needs to decide whether the focused report was among the ones the server removed.
 */
export function useImportHistoryDeletion(runId: number | null) {
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  /**
   * One rule for both paths, keyed on the ids the SERVER reports as deleted — never on a
   * cached row's counters. Eviction has to precede invalidation: a cached detail otherwise
   * keeps the deep-linked card off its 404 arm and re-seeds the deleted row into the list.
   */
  const applyDeletion = useCallback((ids: number[]) => {
    for (const id of ids) {
      queryClient.removeQueries({ queryKey: queryKeys.importSubmissions.detail(id), exact: true });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.importSubmissions.root() });
    if (runId != null && ids.includes(runId)) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('run');
        return next;
      }, { replace: true });
    }
  }, [queryClient, runId, setSearchParams]);

  const deleteMutation = useMutation({
    // A 404 means someone else already deleted it: same cleanup, no error surface.
    mutationFn: async (id: number) => {
      try {
        await api.discardImportSubmission(id);
      } catch (err: unknown) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      return id;
    },
    onMutate: () => { setError(null); },
    onSuccess: (id) => {
      applyDeletion([id]);
      toast.success('Import run deleted');
    },
    onError: (err: unknown) => {
      setError(isInFlight(err) ? IN_FLIGHT_COPY : `Couldn’t delete this import run: ${getErrorMessage(err)}`);
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearCompletedImportSubmissions(),
    onMutate: () => { setError(null); },
    onSuccess: (result) => {
      applyDeletion(result.ids);
      toast.success(clearedCopy(result.deleted));
    },
    onError: (err: unknown) => {
      setError(`Couldn’t clear completed runs: ${getErrorMessage(err)}`);
    },
  });

  return { deleteMutation, clearMutation, error };
}
