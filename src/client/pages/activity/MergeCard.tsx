import { LoadingSpinner, CheckCircleIcon, AlertCircleIcon, RefreshIcon } from '@/components/icons';
import { formatMergePhase } from '@/lib/format/merge.js';
import type { MergeCardState } from '@/hooks/useMergeProgress';

function MergeStatusIcon({ state }: { state: MergeCardState }) {
  if (state.outcome === 'success') return <CheckCircleIcon className="w-4 h-4 text-success" />;
  if (state.outcome === 'error') return <AlertCircleIcon className="w-4 h-4 text-destructive" />;
  if (state.phase === 'queued') return <LoadingSpinner className="w-4 h-4 text-primary" />;
  return <RefreshIcon className="w-4 h-4 text-primary animate-spin" />;
}

export function MergeCard({ state }: { state: MergeCardState }) {
  const isError = state.outcome === 'error';
  const isSuccess = state.outcome === 'success';
  const percentage = state.percentage !== undefined ? Math.round(state.percentage * 100) : undefined;

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up border border-primary/20">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="p-1.5 bg-primary/10 rounded-lg">
          <MergeStatusIcon state={state} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm truncate">{state.bookTitle}</h3>
          <p className="text-xs text-muted-foreground">
            {formatMergePhase(state.phase, state.percentage, state.position)}
          </p>
        </div>
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
