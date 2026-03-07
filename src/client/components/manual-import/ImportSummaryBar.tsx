import { type ImportMode } from '@/lib/api';
import { ChevronDownIcon, LoadingSpinner } from '@/components/icons';

interface ImportSummaryBarProps {
  readyCount: number;
  reviewCount: number;
  noMatchCount: number;
  pendingCount: number;
  selectedCount: number;
  selectedUnmatchedCount: number;
  skippedDuplicates: number;
  isMatching: boolean;
  mode: ImportMode;
  onModeChange: (mode: ImportMode) => void;
  onImport: () => void;
  importing: boolean;
}

export function ImportSummaryBar({
  readyCount,
  reviewCount,
  noMatchCount,
  pendingCount,
  selectedCount,
  selectedUnmatchedCount,
  skippedDuplicates,
  isMatching,
  mode,
  onModeChange,
  onImport,
  importing,
}: ImportSummaryBarProps) {
  return (
    <div className="sticky bottom-0 z-10 glass-card border-t border-white/10 rounded-b-xl px-4 py-3 flex items-center justify-between gap-4">
      {/* Counts */}
      <div className="flex items-center gap-3 text-xs">
        {readyCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {readyCount} ready
          </span>
        )}
        {reviewCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            {reviewCount} review
          </span>
        )}
        {noMatchCount > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            {noMatchCount} no match
          </span>
        )}
        {pendingCount > 0 && (
          <span className="flex items-center gap-1.5 text-muted-foreground/50">
            <LoadingSpinner className="w-3 h-3" />
            {pendingCount} matching
          </span>
        )}
        {skippedDuplicates > 0 && (
          <span className="text-muted-foreground/40">
            {skippedDuplicates} duplicate{skippedDuplicates !== 1 ? 's' : ''} skipped
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {/* Mode dropdown */}
        <div className="relative">
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as ImportMode)}
            className="appearance-none glass-card rounded-lg pl-3 pr-7 py-2 text-sm font-medium text-foreground focus-ring cursor-pointer"
          >
            <option value="copy">Copy</option>
            <option value="move">Move</option>
          </select>
          <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
        </div>

        <button
          onClick={onImport}
          disabled={selectedCount === 0 || selectedUnmatchedCount > 0 || isMatching || importing}
          className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 hover:shadow-glow transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          title={selectedUnmatchedCount > 0 ? `${selectedUnmatchedCount} selected book${selectedUnmatchedCount !== 1 ? 's need' : ' needs'} a match` : undefined}
        >
          {importing ? (
            <span className="flex items-center gap-2">
              <LoadingSpinner className="w-3.5 h-3.5" />
              Importing...
            </span>
          ) : (
            `Import ${selectedCount} book${selectedCount !== 1 ? 's' : ''}`
          )}
        </button>
      </div>
    </div>
  );
}
