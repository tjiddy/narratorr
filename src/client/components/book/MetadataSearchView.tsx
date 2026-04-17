import type { BookMetadata } from '@/lib/api';
import { SearchIcon, LoadingSpinner, AlertCircleIcon } from '@/components/icons';
import { MetadataResultList } from './MetadataResultList';

interface MetadataSearchViewProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  isPending: boolean;
  searchResults: BookMetadata[];
  hasSearched: boolean;
  searchError: string | null;
  onSearch: () => void;
  onApplyMetadata: (meta: BookMetadata) => void;
}

export function MetadataSearchView({
  searchQuery,
  onSearchQueryChange,
  isPending,
  searchResults,
  hasSearched,
  searchError,
  onSearch,
  onApplyMetadata,
}: MetadataSearchViewProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearch();
    }
  };

  return (
    <div className="p-6 space-y-4 overflow-y-auto">
      <div className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search by title and author..."
          className="flex-1 px-3 py-2 glass-card rounded-xl text-sm focus-ring"
          aria-label="Search query"
          autoFocus
        />
        <button
          type="button"
          onClick={onSearch}
          disabled={!searchQuery.trim() || isPending}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
        >
          {isPending ? (
            <LoadingSpinner className="w-3.5 h-3.5" />
          ) : (
            <SearchIcon className="w-3.5 h-3.5" />
          )}
          Search
        </button>
      </div>

      {searchError && (
        <div className="flex items-center gap-2 text-xs text-red-400">
          <AlertCircleIcon className="w-3.5 h-3.5 shrink-0" />
          {searchError}
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground/70">Select a match</p>
          <MetadataResultList
            results={searchResults}
            limit={8}
            maxHeight="max-h-72"
            onSelect={onApplyMetadata}
            showSeries
            coverSize="md"
            placeholderIcon={<SearchIcon className="w-3 h-3 text-muted-foreground/20" />}
            itemClassName="w-full flex items-center gap-3 px-2.5 py-2 text-left rounded-xl hover:bg-muted/40 border border-transparent hover:border-border/30 transition-all group"
          />
        </div>
      )}

      {hasSearched && searchResults.length === 0 && !searchError && (
        <p className="text-xs text-muted-foreground/50 text-center py-2">
          No results found. Try a different search query.
        </p>
      )}

      {!hasSearched && !isPending && !searchError && (
        <p className="text-xs text-muted-foreground/40 text-center py-4">
          Search to find metadata and auto-fill fields.
        </p>
      )}
    </div>
  );
}
