import { useState } from 'react';
import type { SubmissionSummary } from '@/lib/api';
import { StatusChip, DispositionCounts } from '@/components/import-report/ImportReportBits';
import { relativeWhen } from '@/lib/import-report/rowDisplay';
import { ImportDetailExpansion } from '@/components/import-report/ImportDetailExpansion';

/** Header state comes from the cache-patched summary; expansion owns detail polling and pruned-run handling. */
export function ImportHistoryCard({ row, defaultExpanded = false }: { row: SubmissionSummary; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const sourceLabel = row.source === 'library' ? 'Library' : 'Manual';

  return (
    <div className="rounded-lg border border-border" data-testid={`import-history-card-${row.id}`}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left"
        aria-expanded={expanded}
      >
        <StatusChip status={row.status} />
        <span className="text-sm font-medium">
          {sourceLabel}
          {row.mode ? <span className="text-muted-foreground"> · {row.mode}</span> : null}
        </span>
        <span className="text-xs text-muted-foreground">{relativeWhen(row)}</span>
        <span className="ml-auto">
          <DispositionCounts aggregates={row.aggregates} />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/50 px-3 pb-2">
          {/* Always query expanded details; a pruned run is a valid expired-details response. */}
          <ImportDetailExpansion id={row.id} enabled={expanded} />
        </div>
      )}
    </div>
  );
}
