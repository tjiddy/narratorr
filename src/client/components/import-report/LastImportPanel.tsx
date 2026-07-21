import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLatestImport } from '@/hooks/useImportReport';
import { StatusChip, DispositionCounts, relativeWhen } from './ImportReportBits';
import { ImportDetailExpansion } from './ImportDetailExpansion';

/**
 * Last-import panel (#1894) — a compact card at the top of Library Import and
 * Manual Import, fetched FRESH ON MOUNT from the source-scoped latest read,
 * independent of in-memory upload state. Hidden when no submission exists for the
 * source. Non-`complete` statuses poll fast for live progress; once complete it
 * downshifts to baseline (never stops) so it discovers the next run on the same
 * mounted page. On the stale-interim refetch the last-good content stays visible
 * with a subtle "refreshing…" affordance (only a cold first load shows a skeleton).
 */
export function LastImportPanel({ source }: { source: 'library' | 'manual' }) {
  const [expanded, setExpanded] = useState(false);
  const query = useLatestImport(source);
  const latest = query.data;

  // Cold first load (no cached data yet) → skeleton.
  if (query.isLoading) {
    return <div className="mb-4 h-16 animate-pulse rounded-lg border border-border bg-muted/30" data-testid="last-import-skeleton" />;
  }

  // Fetch failed with nothing to show → inline error + retry (never hidden).
  if (query.isError && !latest) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3 text-sm text-destructive">
        <span>Couldn’t load the last import.</span>
        <button type="button" className="underline" onClick={() => query.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  // No submission for this source → panel is hidden.
  if (!latest) return null;

  return (
    <div className="mb-4 rounded-lg border border-border p-3" data-testid="last-import-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusChip status={latest.status} />
        <span className="text-sm font-medium">Last import</span>
        <span className="text-xs text-muted-foreground">{relativeWhen(latest)}</span>
        {query.isFetching && (
          <span className="text-xs italic text-muted-foreground" data-testid="last-import-refreshing">refreshing…</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <Link to={`/activity?tab=history&run=${latest.id}`} className="text-xs text-primary hover:underline">
            View in Activity
          </Link>
          <button type="button" className="text-xs underline" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Hide' : 'Details'}
          </button>
        </span>
      </div>
      <div className="mt-2">
        <DispositionCounts aggregates={latest.aggregates} />
      </div>
      {expanded && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <ImportDetailExpansion id={latest.id} enabled={expanded} />
        </div>
      )}
    </div>
  );
}
