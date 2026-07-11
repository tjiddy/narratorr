import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import type { GrabPayload } from '../../shared/schemas/search.js';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

// ============================================================================
// useReplaceGrab (#1857)
//
// The grab-time cancel-&-replace state machine, extracted from SearchReleasesModal
// so the modal stays a renderer within the enforced complexity/size caps and this
// flow is independently unit-testable. Owns: the grab mutation, the pending-replace
// payload, the multi-code 409 branching, and the confirm-dialog view model.
// ============================================================================

type PipelineActiveReason = 'processing' | 'awaiting_review';

interface ConflictBody {
  code?: string;
  active?: { title?: string };
  count?: number;
  reason?: PipelineActiveReason;
}

interface PendingReplace {
  /** The original grab payload (without `replace`), re-issued with `replace: true`. */
  payload: GrabPayload;
  /** The release the user chose to grab (for the confirm copy). */
  selectedTitle: string;
  /** The active download(s) being replaced (for the confirm copy). */
  activeTitle: string;
  count: number;
}

export interface ReplaceConfirm {
  isOpen: true;
  title: string;
  message: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function pipelineActiveMessage(reason: PipelineActiveReason | undefined, bookTitle: string): string {
  // AC10 requires a book-NAMED toast (no transport vocabulary). Name the book by
  // title; fall back to "This book" only when a title is somehow unavailable.
  const name = bookTitle ? `“${bookTitle}”` : 'This book';
  if (reason === 'awaiting_review') {
    return `${name} has a download awaiting your review — approve or reject it on the Activity page.`;
  }
  return `${name} is already being imported — wait for it to finish.`;
}

function confirmMessage(pending: PendingReplace): string {
  if (pending.count > 1) {
    return `You already have ${pending.count} downloads in progress for this book. Cancel them and grab “${pending.selectedTitle}” instead?`;
  }
  const active = pending.activeTitle || 'a download';
  return `You already have a download in progress for this book (${active}). Cancel it and grab “${pending.selectedTitle}” instead?`;
}

export interface UseReplaceGrabResult {
  /** Start a grab for a fully-built payload (the modal supplies the SearchResult fields). */
  grab: (payload: GrabPayload) => void;
  /** Whether a grab (initial or confirmed replace) is in flight. */
  isGrabbing: boolean;
  /** The confirm-dialog view model when a replaceable conflict is pending, else null. */
  confirm: ReplaceConfirm | null;
  /** Clear pending state (call on modal close / book change). */
  reset: () => void;
}

export function useReplaceGrab(onGrabSuccess: () => void, bookTitle: string): UseReplaceGrabResult {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingReplace | null>(null);

  // Lifecycle generation (F17): every teardown — modal close / book change — bumps
  // this. A grab's callbacks capture the generation at `onMutate` time and no-op if
  // it has since changed, so a response that resolves AFTER the modal closed or its
  // book switched can never repopulate a confirm for, or close/replace against, the
  // wrong book. `reset()` is the teardown seam the modal already calls on both events.
  const genRef = useRef(0);
  const reset = useCallback(() => {
    genRef.current += 1;
    setPending(null);
  }, []);

  const grabMutation = useMutation({
    mutationFn: (payload: GrabPayload) => api.searchGrab(payload),
    onMutate: () => ({ gen: genRef.current }),
    onSuccess: (_data, _vars, context: { gen: number }) => {
      // The grab DID succeed server-side — ALWAYS reconcile the two server-state
      // caches, even for a generation-stale response (close/book change mid-flight),
      // so book status + Activity don't stay cached as if the grab never happened (F23).
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
      // Lifecycle-LOCAL effects (toast, pending clear, close) only for the live context.
      if (context.gen !== genRef.current) return; // stale response after close/book change
      toast.success('Download started! Check the Activity page.');
      setPending(null);
      onGrabSuccess();
    },
    onError: (err: Error, variables: GrabPayload, context: { gen: number } | undefined) => {
      if (context && context.gen !== genRef.current) return; // stale response after close/book change
      const wasConfirmedRetry = variables.replace === true;
      if (err instanceof ApiError && err.status === 409) {
        const body = (err.body ?? {}) as ConflictBody;
        // PIPELINE_ACTIVE — not swappable. Honest, book-named toast keyed on reason,
        // on the initial grab AND on a confirmed replace that lost the race.
        if (body.code === 'PIPELINE_ACTIVE') {
          setPending(null);
          toast.error(pipelineActiveMessage(body.reason, bookTitle));
          return;
        }
        // ACTIVE_DOWNLOAD_EXISTS on the INITIAL grab → offer confirm→replace.
        if (body.code === 'ACTIVE_DOWNLOAD_EXISTS' && !wasConfirmedRetry) {
          setPending({
            payload: variables,
            selectedTitle: variables.title,
            activeTitle: body.active?.title ?? '',
            count: body.count ?? 1,
          });
          return;
        }
      }
      // Generic error, OR any confirmed-retry failure → clear pending, generic toast.
      setPending(null);
      toast.error(`Failed to grab: ${getErrorMessage(err)}.`);
    },
  });

  const grab = useCallback((payload: GrabPayload) => grabMutation.mutate(payload), [grabMutation]);

  const confirm: ReplaceConfirm | null = pending
    ? {
        isOpen: true,
        title: 'Replace active download?',
        message: confirmMessage(pending),
        isPending: grabMutation.isPending,
        onConfirm: () => grabMutation.mutate({ ...pending.payload, replace: true }),
        onCancel: () => setPending(null),
      }
    : null;

  return { grab, isGrabbing: grabMutation.isPending, confirm, reset };
}
