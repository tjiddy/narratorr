import { type ImportMode } from '@/lib/api';
import { ChevronDownIcon, LoadingSpinner } from '@/components/icons';

interface ImportSummaryBarBaseProps {
  readyCount: number;
  reviewCount: number;
  noMatchCount: number;
  pendingCount: number;
  selectedCount: number;
  selectedUnmatchedCount: number;
  duplicateCount: number;
  isMatching: boolean;
  mode: ImportMode;
  onImport: () => void;
  importing: boolean;
  /** Override the default "Import N books" CTA label (also used in pending state instead of "Importing...") */
  registerLabel?: string;
  /** When true, disable the action button regardless of other state */
  disabled?: boolean;
}

/**
 * When hideMode is true, the mode dropdown is hidden — onModeChange is not needed.
 * When hideMode is false or absent, the mode dropdown is visible — onModeChange is required.
 */
type ImportSummaryBarProps = ImportSummaryBarBaseProps & (
  | { hideMode: true; onModeChange?: never }
  | { hideMode?: false; onModeChange: (mode: ImportMode) => void }
);

// eslint-disable-next-line complexity -- compound condition is the least-indirection way to express disabled state and pending label
export function ImportSummaryBar({
  readyCount,
  reviewCount,
  noMatchCount,
  pendingCount,
  selectedCount,
  selectedUnmatchedCount,
  duplicateCount,
  isMatching,
  mode,
  onModeChange,
  onImport,
  importing,
  hideMode,
  registerLabel,
  disabled,
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
        {duplicateCount > 0 && (
          <span className="text-muted-foreground/40">
            {duplicateCount} already in library
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {/* Mode dropdown — hidden for in-place registration flows */}
        {!hideMode && (
          <div className="relative">
            <select
              value={mode}
              onChange={(e) => onModeChange?.(e.target.value as ImportMode)}
              className="appearance-none glass-card rounded-lg pl-3 pr-7 py-2 text-sm font-medium text-foreground focus-ring cursor-pointer"
            >
              <option value="copy">Copy</option>
              <option value="move">Move</option>
            </select>
            <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          </div>
        )}

        <button
          onClick={onImport}
          disabled={disabled || selectedCount === 0 || selectedUnmatchedCount > 0 || isMatching || importing}
          className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 hover:shadow-glow transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          title={selectedUnmatchedCount > 0 ? `${selectedUnmatchedCount} selected book${selectedUnmatchedCount !== 1 ? 's need' : ' needs'} a match` : undefined}
        >
          {importing ? (
            <span className="flex items-center gap-2">
              <LoadingSpinner className="w-3.5 h-3.5" />
              {registerLabel ?? 'Importing...'}
            </span>
          ) : (
            registerLabel ?? `Import ${selectedCount} book${selectedCount !== 1 ? 's' : ''}`
          )}
        </button>
      </div>
    </div>
  );
}
