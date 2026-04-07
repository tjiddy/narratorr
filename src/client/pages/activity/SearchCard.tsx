import { LoadingSpinner, CheckCircleIcon, AlertCircleIcon } from '@/components/icons';
import type { SearchCardState, IndexerState } from '@/hooks/useSearchProgress';

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function IndexerRow({ state }: { state: IndexerState }) {
  if (state.status === 'pending') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <LoadingSpinner className="w-4 h-4 text-primary shrink-0" />
        <span className="font-medium">{state.name}</span>
        <span className="text-muted-foreground">searching...</span>
      </div>
    );
  }

  if (state.status === 'complete') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <CheckCircleIcon className="w-4 h-4 text-success shrink-0" />
        <span className="font-medium">{state.name}</span>
        <span className="text-muted-foreground">
          {state.resultsFound} result{state.resultsFound !== 1 ? 's' : ''} · {formatElapsed(state.elapsedMs ?? 0)}
        </span>
      </div>
    );
  }

  // error
  return (
    <div className="flex items-center gap-2 text-sm">
      <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0" />
      <span className="font-medium">{state.name}</span>
      <span className="text-destructive">
        {state.error} · {formatElapsed(state.elapsedMs ?? 0)}
      </span>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  grabbed: 'grabbed',
  no_results: 'no results',
  skipped: 'already downloading',
  grab_error: 'grab failed',
};

export function SearchCard({ state }: { state: SearchCardState }) {
  const overallStatus = state.outcome
    ? STATUS_LABELS[state.outcome] ?? state.outcome
    : 'searching';
  const isTerminalError = state.outcome === 'grab_error' || state.outcome === 'skipped';

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up border border-primary/20">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="p-1.5 bg-primary/10 rounded-lg">
          <LoadingSpinner className={`w-4 h-4 text-primary ${overallStatus !== 'searching' ? 'hidden' : ''}`} />
          {overallStatus === 'grabbed' && <CheckCircleIcon className="w-4 h-4 text-success" />}
          {(overallStatus === 'no results' || isTerminalError) && <AlertCircleIcon className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm truncate">{state.bookTitle}</h3>
          <p className="text-xs text-muted-foreground capitalize">{overallStatus}</p>
        </div>
      </div>

      {/* Outcome message */}
      {state.outcome === 'grabbed' && state.grabbedFrom && (
        <p className="text-sm text-success mb-2">Grabbed from {state.grabbedFrom}</p>
      )}
      {state.outcome === 'no_results' && (
        <p className="text-sm text-muted-foreground mb-2">No results found</p>
      )}
      {state.outcome === 'skipped' && (
        <p className="text-sm text-muted-foreground mb-2">Already has an active download</p>
      )}
      {state.outcome === 'grab_error' && (
        <p className="text-sm text-destructive mb-2">Grab failed</p>
      )}

      {/* Per-indexer breakdown */}
      <div className="space-y-1.5">
        {[...state.indexers.values()].map((indexer, i) => (
          <IndexerRow key={i} state={indexer} />
        ))}
      </div>
    </div>
  );
}
