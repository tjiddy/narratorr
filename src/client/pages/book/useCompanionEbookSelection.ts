import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type CompanionEbookCandidate, type CompanionEbookState } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { SELECTION_SUCCESS_TOAST, selectionErrorMessage } from './companion-ebook-copy.js';

/** Captured at `onMutate`: the lifecycle generation, and the book the write is actually for. */
interface SelectionContext {
  gen: number;
  bookId: number;
}

export interface CompanionEbookSelection {
  /** The owner's pick, held as a FILENAME. Never an index — see below. */
  pickedFilename: string | null;
  setPickedFilename: (filename: string) => void;
  /** The current candidate matching `pickedFilename`, re-derived every render. */
  picked: CompanionEbookCandidate | null;
  mutation: UseMutationResult<CompanionEbookState, Error, number, SelectionContext>;
  /**
   * The teardown seam: advance the lifecycle generation and drop the pending pick. Stable
   * identity, called by the section from a `useLayoutEffect` CLEANUP keyed on `bookId` — the
   * synchronous seam. Owned by the caller rather than by this hook so the ordering can be
   * proved: a test can wrap this one function and assert it fires strictly before the next
   * book is interactive (`rtl-layout-vs-passive-seam-testing`).
   */
  reset: () => void;
}

/**
 * The `ambiguous` picker's local state and its selection mutation (#1963 AC21-AC27).
 *
 * **Pick state is a filename, not an index.** The server regenerates `candidates[].index` from
 * each live `readdir`, and index drift between the `GET` that issued one and the `PUT` that
 * spends it is explicitly accepted server-side. An index is therefore a positional token valid
 * only for the response that produced it: a `checked={picked === candidate.index}` binding
 * would move the owner's selection to a DIFFERENT file whenever a refetch reorders the list.
 * Keying on the filename and re-deriving the index at submit time buys three required
 * behaviours — a reorder keeps the owner's file selected and submits that file; a candidate
 * that disappears from a refetch makes `picked` null so submit disables rather than silently
 * retargeting a sibling; and no `useEffect` syncs query data into state
 * (`derived-state-over-copied`).
 *
 * **The mutation splits server truth from lifecycle-local effects** — the `useReplaceGrab`
 * pattern. Hook-level `useMutation` callbacks fire even after the observer is removed
 * (`react-query-mutation-callbacks-post-unmount`), so an owner who submits on book A and
 * navigates away would otherwise get book A's toast on book B. Cache reconciliation runs
 * unconditionally and keys off `context.bookId`; the toast and the pick clear are gated on the
 * generation. The generation advances in a `useLayoutEffect` CLEANUP keyed on `bookId` — the
 * synchronous seam, which runs before a book change commits, where a passive `useEffect`
 * cleanup would leave a stale-callback window. That same cleanup is AC24's pick reset, so a
 * pick made on one book can never be checked or submitted on another, not even when both books
 * offer a candidate with the same basename.
 */
export function useCompanionEbookSelection(
  bookId: number,
  candidates: CompanionEbookCandidate[],
): CompanionEbookSelection {
  const queryClient = useQueryClient();
  const [pickedFilename, setPickedFilename] = useState<string | null>(null);
  const genRef = useRef(0);

  const reset = useCallback(() => {
    genRef.current += 1;
    setPickedFilename(null);
  }, []);

  const mutation = useMutation<CompanionEbookState, Error, number, SelectionContext>({
    mutationFn: (index: number) => api.putCompanionEbookSelection(bookId, index),
    onMutate: () => ({ gen: genRef.current, bookId }),
    onSuccess: async (result, _index, context) => {
      // A `/state` GET issued BEFORE the write can otherwise land after it and overwrite the
      // committed value with pre-write state (`react-query-optimistic-cancel`).
      await queryClient.cancelQueries({ queryKey: queryKeys.companionEbook(context.bookId) });
      // The 200 body is `projectStoredState(row)` — the same projector `GET /state` uses — so
      // this is a straight assignment, and it is what keeps an obsolete picker from staying on
      // screen when the confirmation refetch fails.
      queryClient.setQueryData(queryKeys.companionEbook(context.bookId), result);
      if (context.gen !== genRef.current) return;
      toast.success(SELECTION_SUCCESS_TOAST);
      setPickedFilename(null);
    },
    onError: (error, _index, context) => {
      if (context && context.gen !== genRef.current) return;
      toast.error(selectionErrorMessage(error));
    },
    onSettled: (_result, _error, _index, context) => {
      // Confirmation, not the only path to correctness: `setQueryData` already made the cache
      // right, so a failing refetch degrades to keeping that value (AC2's data-wins rule).
      queryClient.invalidateQueries({ queryKey: queryKeys.companionEbook(context?.bookId ?? bookId) });
    },
  });

  const picked = candidates.find((candidate) => candidate.filename === pickedFilename) ?? null;

  return { pickedFilename, setPickedFilename, picked, mutation, reset };
}
