import { memo } from 'react';
import type { ImportListExclusion } from '@/lib/api';
import type { ImportListExclusionKind } from '@shared/schemas/import-list-exclusion.js';
import { TrashIcon } from '@/components/icons';

const KIND_LABELS: Record<ImportListExclusionKind, string> = {
  deleted: 'Deleted',
  added: 'Added by a list',
};

interface ImportListExclusionRowProps {
  entry: ImportListExclusion;
  /** Stagger index for the entry animation. */
  index: number;
  /** Must be referentially stable, or memo buys nothing. */
  onRemove: (entry: ImportListExclusion) => void;
}

/**
 * One exclusion card. Memoized and given the whole entry rather than a prebound handler, so the
 * page's `.map()` allocates no per-row closure (REACT-2) and an unrelated page rerender —
 * pagination, modal or mutation state — does not re-render every visible row.
 */
export const ImportListExclusionRow = memo(function ImportListExclusionRow({
  entry,
  index,
  onRemove,
}: ImportListExclusionRowProps) {
  return (
    <div
      className="glass-card rounded-xl p-4 animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm truncate">{entry.title}</h3>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-md font-medium">
              {KIND_LABELS[entry.kind]}
            </span>
            {entry.authorName && (
              <span className="text-xs text-muted-foreground">{entry.authorName}</span>
            )}
            <span className="text-xs px-2 py-0.5 bg-muted rounded-md font-medium text-muted-foreground">
              {entry.importListName ?? 'Unknown list'}
            </span>
            {entry.asin && (
              <span className="text-xs text-muted-foreground font-mono">{entry.asin}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onRemove(entry)}
          className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-ring shrink-0"
          aria-label={`Remove exclusion for ${entry.title}`}
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
});
