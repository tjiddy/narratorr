import { Link } from 'react-router-dom';
import {
  SearchIcon,
  XIcon,
  ChevronDownIcon,
  ArrowUpDownIcon,
  FolderIcon,
} from '@/components/icons';
import { type StatusFilter, type SortField, type SortDirection, filterTabs } from './helpers.js';

const sortLabels: Record<SortField, string> = {
  createdAt: 'Date Added',
  title: 'Title',
  author: 'Author',
};

export function LibraryToolbar({
  searchQuery,
  onSearchChange,
  onSearchClear,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  filtersOpen,
  onFiltersToggle,
  activeFilterCount,
  authorFilter,
  onAuthorFilterChange,
  uniqueAuthors,
  seriesFilter,
  onSeriesFilterChange,
  uniqueSeries,
  sortField,
  onSortFieldChange,
  sortDirection,
  onSortDirectionChange,
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
  authorFilter: string;
  onAuthorFilterChange: (f: string) => void;
  uniqueAuthors: string[];
  seriesFilter: string;
  onSeriesFilterChange: (f: string) => void;
  uniqueSeries: string[];
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sortDirection: SortDirection;
  onSortDirectionChange: (d: SortDirection) => void;
}) {
  return (
    <div className="space-y-3 animate-fade-in-up stagger-1">
      {/* Row 1: Search + status pills + filters toggle */}
      <div className="flex items-center gap-3">
        {/* Search input */}
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

        {/* Status pills */}
        <div className="flex items-center gap-1.5">
          {filterTabs.map((tab) => {
            const isActive = statusFilter === tab.key;
            const count = statusCounts[tab.key];
            return (
              <button
                key={tab.key}
                onClick={() => onStatusFilterChange(tab.key)}
                className={`
                  flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                  transition-all duration-200 focus-ring whitespace-nowrap
                  ${isActive
                    ? 'bg-primary text-primary-foreground shadow-glow'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }
                `}
              >
                {tab.label}
                <span className={`text-[10px] ${isActive ? 'opacity-75' : 'opacity-50'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Filters toggle */}
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

        {/* Manual Import */}
        <Link
          to="/import"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-all duration-200 focus-ring"
        >
          <FolderIcon className="w-3 h-3" />
          Import
        </Link>
      </div>

      {/* Row 2: Collapsible filters + sort */}
      {filtersOpen && (
        <div className="flex flex-wrap items-center gap-3 animate-fade-in">
          {/* Author filter */}
          {uniqueAuthors.length > 1 && (
            <div className="relative">
              <select
                value={authorFilter}
                onChange={(e) => onAuthorFilterChange(e.target.value)}
                className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
              >
                <option value="">All Authors</option>
                {uniqueAuthors.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
          )}

          {/* Series filter */}
          {uniqueSeries.length > 0 && (
            <div className="relative">
              <select
                value={seriesFilter}
                onChange={(e) => onSeriesFilterChange(e.target.value)}
                className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
              >
                <option value="">All Series</option>
                {uniqueSeries.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Sort control */}
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <select
                value={sortField}
                onChange={(e) => onSortFieldChange(e.target.value as SortField)}
                className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
              >
                {Object.entries(sortLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
            <button
              onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
              className="glass-card rounded-lg p-1.5 text-muted-foreground hover:text-foreground transition-colors focus-ring"
              title={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
            >
              <ArrowUpDownIcon className={`w-3.5 h-3.5 transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
