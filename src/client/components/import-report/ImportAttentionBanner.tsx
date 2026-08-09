import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AttentionResponse, type AttentionSubmission } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { useImportAttention } from '@/hooks/useImportReport';
import { attentionCopy } from '@/lib/import-report/attentionCopy';
import { useAttentionDismissal, dismissalKey } from '@/lib/import-report/dismissalStore';

/**
 * Server-authoritative banner. `source` scopes import pages; omission is
 * cross-source. Dismissals use id + kind so later states reappear. Read and
 * discard failures remain visible and retryable.
 */
export function ImportAttentionBanner({
  source,
  onImportAgain,
}: {
  source?: 'library' | 'manual';
  onImportAgain: (data: AttentionSubmission) => void;
}) {
  const query = useImportAttention(source);
  const { isDismissed, dismiss } = useAttentionDismissal();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [discardError, setDiscardError] = useState<string | null>(null);

  const discardMutation = useMutation({
    mutationFn: (id: number) => api.discardImportSubmission(id),
    onSuccess: (_result, discardedId) => {
      setDiscardError(null);
      // Clear every cached copy before refetch; a failed refetch must not resurrect the delete action.
      queryClient.setQueriesData<AttentionResponse>(
        { queryKey: ['importSubmissions', 'attention'] },
        (old) => (old && old.data?.id === discardedId ? { ...old, data: null } : old),
      );
      queryClient.invalidateQueries({ queryKey: ['importSubmissions'] });
    },
    onError: (error: unknown) => setDiscardError(getErrorMessage(error)),
  });

  const attentionError = (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3 text-sm text-destructive" data-testid="attention-error">
      <span>Couldn’t check for import attention.</span>
      <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
    </div>
  );

  const data = query.data?.data ?? null;

  // A cached null envelope must not hide a failed attention read.
  if (!data) {
    return query.isError ? attentionError : null;
  }

  const kind: 'abandoned' | 'completed-attention' = data.attention.kind;
  const key = dismissalKey(data.id, kind);
  if (isDismissed(key)) return query.isError ? attentionError : null;

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" data-testid="import-attention-banner">
      {query.isError && (
        // Retain last-good data while exposing the failed refresh.
        <div className="mb-2 flex items-center gap-2 text-xs text-destructive" data-testid="attention-refresh-error">
          <span>Couldn’t refresh attention.</span>
          <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm">{attentionCopy(data)}</span>
        <span className="ml-auto flex items-center gap-2">
          {kind === 'abandoned' ? (
            <>
              <button
                type="button"
                className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
                disabled={discardMutation.isPending}
                onClick={() => discardMutation.mutate(data.id)}
              >
                Discard
              </button>
              <button
                type="button"
                className="rounded-md bg-muted px-2 py-1 text-xs font-medium hover:text-foreground"
                onClick={() => onImportAgain(data)}
              >
                Import again
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded-md bg-muted px-2 py-1 text-xs font-medium hover:text-foreground"
              onClick={() => {
                dismiss(key);
                navigate(`/activity?tab=history&run=${data.id}`);
              }}
            >
              View details
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => dismiss(key)}
          >
            ✕
          </button>
        </span>
      </div>
      {discardError && (
        <div className="mt-2 flex items-center gap-2 text-xs text-destructive" data-testid="attention-discard-error">
          <span>Couldn’t discard: {discardError}</span>
          <button type="button" className="underline" onClick={() => discardMutation.mutate(data.id)}>Retry</button>
        </div>
      )}
    </div>
  );
}
