import { useState } from 'react';
import type { SubmissionSummary } from '@/lib/api';
import { StatusChip, DispositionCounts } from '@/components/import-report/ImportReportBits';
import { TrashIcon } from '@/components/icons';
import { relativeWhen } from '@/lib/import-report/rowDisplay';
import { ImportDetailExpansion } from '@/components/import-report/ImportDetailExpansion';

/** Header state comes from the cache-patched summary; expansion owns detail polling and pruned-run handling. */
export function ImportHistoryCard({ row, defaultExpanded = false, onDelete, isDeleting = false }: {
  row: SubmissionSummary;
  defaultExpanded?: boolean;
  onDelete?: (id: number) => void;
  isDeleting?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const sourceLabel = row.source === 'library' ? 'Library' : 'Manual';

  return (
    <div className="rounded-lg border border-border" data-testid={`import-history-card-${row.id}`}>
      {/* Delete is a sibling of the toggle: a button nested inside a button is invalid DOM. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left"
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
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(row.id)}
            disabled={isDeleting}
            aria-label="Delete import run"
            className="mr-2 shrink-0 rounded-lg p-1.5 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border/50 px-3 pb-2">
          {/* Always query expanded details; a pruned run is a valid expired-details response. */}
          <ImportDetailExpansion id={row.id} enabled={expanded} />
        </div>
      )}
    </div>
  );
}
