import type { SearchDropSummary } from '@shared/schemas/search-stream.js';
import { SettingsIcon } from '@/components/icons';
import { describeDropReason } from '@/lib/searchDropReasonCopy';

/**
 * The "your settings hid these" empty state — distinct from a genuine indexer miss, which is the
 * whole point: both used to read "No releases found".
 */
export function FilteredOutEmptyState({ filteredOut }: { filteredOut: SearchDropSummary }) {
  const [dominant, ...rest] = filteredOut.reasons;
  if (!dominant) return null;

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      <SettingsIcon className="w-10 h-10 text-muted-foreground/40 mb-4" />
      <p className="text-foreground font-medium">No releases passed your quality filters</p>
      <p className="text-sm text-muted-foreground mt-2">
        All {filteredOut.total} release{filteredOut.total !== 1 ? 's' : ''} were filtered out
        {' — '}
        {dominant.count === filteredOut.total ? 'all' : dominant.count}{' '}
        {describeDropReason(dominant.reason, dominant.threshold)}.
      </p>
      {rest.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {rest.map(entry => (
            <li key={entry.reason}>
              {entry.count} {describeDropReason(entry.reason, entry.threshold)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
