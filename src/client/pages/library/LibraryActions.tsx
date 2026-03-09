import { Link } from 'react-router-dom';
import { SearchIcon, FolderIcon, RefreshIcon, LoadingSpinner, TrashIcon } from '@/components/icons';

export function LibraryActions({
  missingCount, onRemoveMissing,
  onSearchAllWanted, isSearchingAllWanted,
  onRescan, isRescanning,
}: {
  missingCount: number;
  onRemoveMissing: () => void;
  onSearchAllWanted: () => void;
  isSearchingAllWanted: boolean;
  onRescan: () => void;
  isRescanning: boolean;
}) {
  return (
    <>
      {missingCount > 0 && (
        <button
          type="button"
          onClick={onRemoveMissing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200 focus-ring"
        >
          <TrashIcon className="w-3 h-3" />
          Remove Missing
        </button>
      )}

      <button
        type="button"
        onClick={onSearchAllWanted}
        disabled={isSearchingAllWanted}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring disabled:opacity-50 disabled:pointer-events-none"
      >
        {isSearchingAllWanted
          ? <LoadingSpinner className="w-3 h-3" />
          : <SearchIcon className="w-3 h-3" />}
        Search Wanted
      </button>

      <button
        type="button"
        onClick={onRescan}
        disabled={isRescanning}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring disabled:opacity-50 disabled:pointer-events-none"
      >
        {isRescanning
          ? <LoadingSpinner className="w-3 h-3" />
          : <RefreshIcon className="w-3 h-3" />}
        Rescan
      </button>

      <Link
        to="/import"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring"
      >
        <FolderIcon className="w-3 h-3" />
        Import
      </Link>
    </>
  );
}
