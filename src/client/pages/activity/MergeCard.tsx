import { LoadingSpinner } from '@/components/icons';
import { MergeStatusIcon } from '@/components/MergeStatusIcon.js';
import { formatMergePhase } from '@/lib/format/merge.js';
import type { MergeCardState } from '@/hooks/useMergeProgress';

const CANCELLABLE_PHASES = new Set(['queued', 'starting', 'staging', 'processing', 'verifying']);

export function MergeCard({ state, onCancel, isCancelling }: {
  state: MergeCardState;
  onCancel?: (bookId: number) => void;
  isCancelling?: boolean;
}) {
  const isError = state.outcome === 'error';
  const isSuccess = state.outcome === 'success';
  const isCancelled = state.outcome === 'cancelled';
  const percentage = state.percentage !== undefined ? Math.round(state.percentage * 100) : undefined;
  const canCancel = !state.outcome && CANCELLABLE_PHASES.has(state.phase) && onCancel;

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up hover:border-primary/20 transition-all duration-300">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="p-1.5 bg-primary/10 rounded-lg">
          <MergeStatusIcon outcome={state.outcome} phase={state.phase} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm truncate">{state.bookTitle}</h3>
          <p className="text-xs text-muted-foreground">
            {isCancelled
              ? 'Merge cancelled'
              : formatMergePhase(state.phase, state.percentage, state.position)}
          </p>
        </div>
        {canCancel && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
            onClick={() => onCancel(state.bookId)}
            disabled={isCancelling}
            aria-label="Cancel merge"
          >
            {isCancelling ? <LoadingSpinner className="w-3.5 h-3.5" /> : 'Cancel'}
          </button>
        )}
      </div>

      {/* Progress bar (processing phase only) */}
      {state.phase === 'processing' && percentage !== undefined && (
        <div className="mb-2">
          <div
            className="h-1.5 rounded-full bg-muted overflow-hidden"
            role="progressbar"
            aria-valuenow={percentage}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      )}

      {/* Terminal outcome messages */}
      {isSuccess && state.message && (
        <p className="text-sm text-success mb-1">{state.message}</p>
      )}
      {isError && (
        <p className="text-sm text-destructive mb-1">{state.error || 'Merge failed'}</p>
      )}
      {isSuccess && state.enrichmentWarning && (
        <p className="text-sm text-warning">{state.enrichmentWarning}</p>
      )}
    </div>
  );
}
