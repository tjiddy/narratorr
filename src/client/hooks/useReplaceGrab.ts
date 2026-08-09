import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import type { GrabPayload } from '@shared/schemas/search.js';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

type PipelineActiveReason = 'processing' | 'awaiting_review';

interface ConflictBody {
  code?: string;
  active?: { title?: string };
  count?: number;
  reason?: PipelineActiveReason;
}

interface PendingReplace {
  /** Reused with `replace: true` after confirmation. */
  payload: GrabPayload;
  selectedTitle: string;
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
  // User-facing errors name the book and hide transport details.
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
  grab: (payload: GrabPayload) => void;
  isGrabbing: boolean;
  confirm: ReplaceConfirm | null;
  /** Clears pending state and invalidates callbacks after modal close or book change. */
  reset: () => void;
}

export function useReplaceGrab(onGrabSuccess: () => void, bookTitle: string): UseReplaceGrabResult {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingReplace | null>(null);

  // reset() advances the lifecycle so callbacks from a closed modal or previous book cannot mutate this view.
  const genRef = useRef(0);
  const reset = useCallback(() => {
    genRef.current += 1;
    setPending(null);
  }, []);

  const grabMutation = useMutation({
    mutationFn: (payload: GrabPayload) => api.searchGrab(payload),
    onMutate: () => ({ gen: genRef.current }),
    onSuccess: (_data, _vars, context: { gen: number }) => {
      // The server changed even if this lifecycle is stale; always reconcile shared caches.
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
      // Suppress lifecycle-local effects after close or book change.
      if (context.gen !== genRef.current) return;
      toast.success('Download started! Check the Activity page.');
      setPending(null);
      onGrabSuccess();
    },
    onError: (err: Error, variables: GrabPayload, context: { gen: number } | undefined) => {
      if (context && context.gen !== genRef.current) return;
      const wasConfirmedRetry = variables.replace === true;
      if (err instanceof ApiError && err.status === 409) {
        const body = (err.body ?? {}) as ConflictBody;
        // Pipeline conflicts cannot be replaced, including after a confirmed grab loses its race.
        if (body.code === 'PIPELINE_ACTIVE') {
          setPending(null);
          toast.error(pipelineActiveMessage(body.reason, bookTitle));
          return;
        }
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
