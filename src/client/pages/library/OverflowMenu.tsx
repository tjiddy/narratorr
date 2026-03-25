import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreVerticalIcon, SearchIcon, FolderIcon, RefreshIcon, LoadingSpinner, TrashIcon } from '@/components/icons';
import { ToolbarDropdown } from '@/components/ToolbarDropdown';

export function OverflowMenu({
  missingCount,
  onRemoveMissing,
  onSearchAllWanted,
  isSearchingAllWanted,
  onRescan,
  isRescanning,
}: {
  missingCount: number;
  onRemoveMissing: () => void;
  onSearchAllWanted: () => void;
  isSearchingAllWanted: boolean;
  onRescan: () => void;
  isRescanning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleAction(fn: () => void) {
    fn();
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="More actions"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring"
      >
        <MoreVerticalIcon className="w-4 h-4" />
      </button>

      <ToolbarDropdown triggerRef={triggerRef} open={open} onClose={() => setOpen(false)}>
        <div
          role="menu"
          className="min-w-[160px] glass-card rounded-xl overflow-hidden shadow-lg border border-border animate-fade-in"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => handleAction(onSearchAllWanted)}
            disabled={isSearchingAllWanted}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus:outline-none"
          >
            {isSearchingAllWanted
              ? <LoadingSpinner className="w-3.5 h-3.5" />
              : <SearchIcon className="w-3.5 h-3.5" />}
            Search Wanted
          </button>

          <button
            role="menuitem"
            type="button"
            onClick={() => handleAction(onRescan)}
            disabled={isRescanning}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus:bg-muted/50 focus:outline-none"
          >
            {isRescanning
              ? <LoadingSpinner className="w-3.5 h-3.5" />
              : <RefreshIcon className="w-3.5 h-3.5" />}
            Rescan
          </button>

          <Link
            role="menuitem"
            to="/import"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors focus:bg-muted/50 focus:outline-none"
          >
            <FolderIcon className="w-3.5 h-3.5" />
            Import
          </Link>

          {missingCount > 0 && (
            <>
              <div className="border-t border-border/50 mx-2" />
              <button
                role="menuitem"
                type="button"
                onClick={() => handleAction(onRemoveMissing)}
                className="flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors focus:bg-red-500/10 focus:outline-none"
              >
                <TrashIcon className="w-3.5 h-3.5" />
                Remove Missing
              </button>
            </>
          )}
        </div>
      </ToolbarDropdown>
    </div>
  );
}
