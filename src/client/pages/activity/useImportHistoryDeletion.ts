import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { SUBMISSION_ERROR_CODES } from '@core/import-staging/schemas.js';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useGenerationGuard, type GenerationContext } from '@/hooks/useGenerationGuard';
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

/** A deep link is `?run=<positive integer>`; anything else focuses nothing. */
export function parseRun(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Owns both delete mutations at section scope so their callbacks cannot fire against an unmounted row. */
export function useImportHistoryDeletion() {
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  // ActivityPage drops this section when the user leaves the History tab, but hook-level mutation
  // callbacks still fire. One guard serves both mutations: a callback landing after teardown sees
  // a stale generation and skips the lifecycle-local half.
  const { capture, isLive } = useGenerationGuard();

  /**
   * One rule for both paths, keyed on the ids the SERVER reports as deleted — never on a
   * cached row's counters. Eviction has to precede invalidation: a cached detail otherwise
   * keeps the deep-linked card off its 404 arm and re-seeds the deleted row into the list.
   */
  const applyDeletion = useCallback((ids: number[], live: boolean) => {
    // The server changed whatever this section's lifecycle did, so cache reconciliation is unconditional.
    for (const id of ids) {
      queryClient.removeQueries({ queryKey: queryKeys.importSubmissions.detail(id), exact: true });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.importSubmissions.root() });
    if (!live || ids.length === 0) return;
    setSearchParams((prev) => {
      // Decide from the live URL, not a mutate-time capture: focus can move while a delete is in flight.
      const focused = parseRun(prev.get('run'));
      if (focused == null || !ids.includes(focused)) return prev;
      const next = new URLSearchParams(prev);
      next.delete('run');
      return next;
    }, { replace: true });
  }, [queryClient, setSearchParams]);

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
    onMutate: () => { setError(null); return capture(); },
    onSuccess: (id, _vars, context: GenerationContext) => {
      const live = isLive(context);
      applyDeletion([id], live);
      if (!live) return;
      toast.success('Import run deleted');
    },
    onError: (err: unknown, _vars, context: GenerationContext | undefined) => {
      if (!isLive(context)) return;
      setError(isInFlight(err) ? IN_FLIGHT_COPY : `Couldn’t delete this import run: ${getErrorMessage(err)}`);
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearCompletedImportSubmissions(),
    onMutate: () => { setError(null); return capture(); },
    onSuccess: (result, _vars, context: GenerationContext) => {
      const live = isLive(context);
      applyDeletion(result.ids, live);
      if (!live) return;
      toast.success(clearedCopy(result.deleted));
    },
    onError: (err: unknown, _vars, context: GenerationContext | undefined) => {
      if (!isLive(context)) return;
      setError(`Couldn’t clear completed runs: ${getErrorMessage(err)}`);
    },
  });

  return { deleteMutation, clearMutation, error };
}
