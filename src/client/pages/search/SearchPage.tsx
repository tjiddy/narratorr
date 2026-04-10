import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMetadataSearch } from '@/hooks/useMetadata';
import { SearchIcon, LoadingSpinner } from '@/components/icons';
import { SearchResults } from './SearchResults.js';

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);
  const [searchTerm, setSearchTerm] = useState(initialQuery.length >= 2 ? initialQuery : '');
  const queryClient = useQueryClient();

  const { data: metadataResults, isLoading, error } = useMetadataSearch(searchTerm);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchTerm(query);
  };

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Add Book</h1>
        <p className="text-muted-foreground mt-1">Search metadata providers to find audiobooks to add</p>
      </div>

      {/* Search Form */}
      <form onSubmit={handleSearch} className="max-w-3xl mx-auto animate-fade-in-up stagger-1">
        <div className="relative group">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-primary to-amber-500 rounded-2xl opacity-20 blur-lg group-hover:opacity-30 transition-opacity" />
          <div className="relative flex items-center glass-card rounded-2xl overflow-hidden">
            <div className="flex items-center justify-center pl-3 sm:pl-5 pr-1 sm:pr-2 text-muted-foreground">
              {isLoading ? (
                <LoadingSpinner className="w-5 h-5" />
              ) : (
                <SearchIcon className="w-5 h-5" />
              )}
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, author, or series..."
              autoFocus
              className="flex-1 bg-transparent px-2 sm:px-4 py-4 text-base sm:text-lg placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
            />
            <button
              type="submit"
              disabled={isLoading || query.length < 2}
              className="shrink-0 m-1.5 sm:m-2 px-3 sm:px-6 py-2 sm:py-2.5 bg-primary text-primary-foreground text-sm sm:text-base font-medium rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 focus-ring"
            >
              {isLoading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>
      </form>

      {/* Error */}
      {error && (
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl animate-fade-in">
            <p>{error.message}</p>
          </div>
        </div>
      )}

      {/* Results */}
      <SearchResults
        results={metadataResults}
        searchTerm={searchTerm}
        queryClient={queryClient}
      />
    </div>
  );
}
