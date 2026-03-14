import { SearchIcon, XIcon, ChevronDownIcon, LibraryIcon } from '@/components/icons';
import { type StatusFilter } from './helpers.js';
import { StatusPills } from './StatusPills';
import { FilterRow, type FilterProps } from './FilterRow';
import { SortControls, type SortProps } from './SortControls';
import { ViewToggle } from './ViewToggle.js';
import { LibraryActions } from './LibraryActions.js';

export type ViewMode = 'grid' | 'table';

export function LibraryToolbar({
  searchQuery, onSearchChange, onSearchClear,
  statusFilter, onStatusFilterChange, statusCounts,
  filtersOpen, onFiltersToggle, activeFilterCount,
  filterProps,
  sortProps,
  collapseSeriesEnabled, onCollapseSeriesToggle,
  viewMode, onViewModeChange,
  onRescan, isRescanning,
  missingCount, onRemoveMissing,
  onSearchAllWanted, isSearchingAllWanted,
}: {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchClear: () => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
  filtersOpen: boolean;
  onFiltersToggle: () => void;
  activeFilterCount: number;
  filterProps: FilterProps;
  sortProps: SortProps;
  collapseSeriesEnabled: boolean;
  onCollapseSeriesToggle: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onRescan: () => void;
  isRescanning: boolean;
  missingCount: number;
  onRemoveMissing: () => void;
  onSearchAllWanted: () => void;
  isSearchingAllWanted: boolean;
}) {
  return (
    <div className="space-y-3 animate-fade-in-up stagger-1">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search library..."
            className="w-full glass-card rounded-xl pl-9 pr-9 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-ring"
          />
          {searchQuery && (
            <button
              onClick={onSearchClear}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <StatusPills
          statusFilter={statusFilter}
          onStatusFilterChange={onStatusFilterChange}
          statusCounts={statusCounts}
        />

        <button
          onClick={onFiltersToggle}
          aria-label="Toggle filters"
          className={`
            relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 focus-ring
            ${filtersOpen
              ? 'bg-muted/80 text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }
          `}
        >
          <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${filtersOpen ? 'rotate-180' : ''}`} />
          Filters
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
              {activeFilterCount}
            </span>
          )}
        </button>

        <SortControls {...sortProps} />

        <button
          onClick={onCollapseSeriesToggle}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 focus-ring
            ${collapseSeriesEnabled
              ? 'bg-muted/80 text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }
          `}
          aria-label="Collapse series"
          aria-pressed={collapseSeriesEnabled}
        >
          <LibraryIcon className="w-3 h-3" />
          Series
        </button>

        <ViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />

        <LibraryActions
          missingCount={missingCount}
          onRemoveMissing={onRemoveMissing}
          onSearchAllWanted={onSearchAllWanted}
          isSearchingAllWanted={isSearchingAllWanted}
          onRescan={onRescan}
          isRescanning={isRescanning}
        />
      </div>

      {filtersOpen && <FilterRow {...filterProps} />}
    </div>
  );
}
