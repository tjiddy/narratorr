import { useCallback, useState } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type CompanionEbookCandidate, type CompanionEbookState } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { SELECTION_SUCCESS_TOAST, selectionErrorMessage } from './companion-ebook-copy.js';
import { useGenerationGuard, type GenerationContext } from '@/hooks/useGenerationGuard';

/** `gen` comes from the guard so the stamp and the check cannot drift apart. */
interface SelectionContext extends GenerationContext {
  bookId: number;
}

export interface CompanionEbookSelection {
  /** The owner's pick is a filename, never a positional index. */
  pickedFilename: string | null;
  setPickedFilename: (filename: string) => void;
  picked: CompanionEbookCandidate | null;
  mutation: UseMutationResult<CompanionEbookState, Error, number, SelectionContext>;
  /** Stable teardown advances the generation and clears the pick; caller-owned layout cleanup keeps ordering testable. */
  reset: () => void;
}

/**
 * Store filename identity and derive the current positional index so reorder and disappearance
 * cannot silently retarget a choice (#1963 AC21-AC27). Mutation callbacks outlive observers, so
 * cache reconciliation always uses the captured book while toast and pick effects require the
 * current generation. The caller advances that generation in layout cleanup before book commit.
 */
export function useCompanionEbookSelection(
  bookId: number,
  candidates: CompanionEbookCandidate[],
): CompanionEbookSelection {
  const queryClient = useQueryClient();
  const [pickedFilename, setPickedFilename] = useState<string | null>(null);
  const { capture, isLive, retire } = useGenerationGuard();

  const reset = useCallback(() => {
    retire();
    setPickedFilename(null);
  }, [retire]);

  const mutation = useMutation<CompanionEbookState, Error, number, SelectionContext>({
    mutationFn: (index: number) => api.putCompanionEbookSelection(bookId, index),
    onMutate: () => ({ ...capture(), bookId }),
    onSuccess: async (result, _index, context) => {
      // Cancel pre-write state reads before they can overwrite the committed result.
      await queryClient.cancelQueries({ queryKey: queryKeys.companionEbook(context.bookId) });
      // The mutation and GET share a response shape, so assignment remains correct if refetch fails.
      queryClient.setQueryData(queryKeys.companionEbook(context.bookId), result);
      if (!isLive(context)) return;
      toast.success(SELECTION_SUCCESS_TOAST);
      setPickedFilename(null);
    },
    onError: (error, _index, context) => {
      if (!isLive(context)) return;
      toast.error(selectionErrorMessage(error));
    },
    onSettled: (_result, _error, _index, context) => {
      // This confirms the assigned cache value; correctness does not depend on refetch success.
      queryClient.invalidateQueries({ queryKey: queryKeys.companionEbook(context?.bookId ?? bookId) });
    },
  });

  const picked = candidates.find((candidate) => candidate.filename === pickedFilename) ?? null;

  return { pickedFilename, setPickedFilename, picked, mutation, reset };
}
