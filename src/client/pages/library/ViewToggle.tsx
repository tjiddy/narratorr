import { GridIcon, ListIcon } from '@/components/icons';
import type { ViewMode } from './LibraryToolbar.js';

export function ViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-center glass-card rounded-lg overflow-hidden" role="group" aria-label="View mode">
      <button
        type="button"
        onClick={() => onViewModeChange('grid')}
        className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        aria-label="Grid view"
        aria-pressed={viewMode === 'grid'}
      >
        <GridIcon className="w-3.5 h-3.5" />
      </button>
      <div className="w-px h-4 bg-border/50" />
      <button
        type="button"
        onClick={() => onViewModeChange('table')}
        className={`p-1.5 transition-colors ${viewMode === 'table' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        aria-label="Table view"
        aria-pressed={viewMode === 'table'}
      >
        <ListIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
