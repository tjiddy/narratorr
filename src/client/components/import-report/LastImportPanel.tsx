import { useState } from 'react';
import { Link } from 'react-router';
import { submissionSummarySchema } from '@core/import-staging/schemas.js';
import { useLatestImport } from '@/hooks/useImportReport';
import { useDtoValid } from '@/lib/import-report/useDtoWarn';
import { StatusChip, DispositionCounts } from './ImportReportBits';
import { relativeWhen } from '@/lib/import-report/rowDisplay';
import { ImportDetailExpansion } from './ImportDetailExpansion';

/**
 * Source-scoped latest import, fetched on mount independently of upload state.
 * Active runs poll fast; complete or absent runs retain baseline discovery.
 * Refetches keep last-good content, while only a cold load shows the skeleton.
 */
export function LastImportPanel({ source }: { source: 'library' | 'manual' }) {
  const [expanded, setExpanded] = useState(false);
  const query = useLatestImport(source);
  const latest = query.data;
  // Validate before indexed status maps so malformed DTOs cannot crash the section.
  const latestValid = useDtoValid(submissionSummarySchema, latest, 'latest import summary');

  if (query.isLoading) {
    return <div className="mb-4 h-16 animate-pulse rounded-lg border border-border bg-muted/30" data-testid="last-import-skeleton" />;
  }

  if (latest && !latestValid) {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border p-3 text-sm text-destructive" data-testid="last-import-malformed">
        <span>The last import couldn’t be displayed.</span>
        <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
      </div>
    );
  }

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
