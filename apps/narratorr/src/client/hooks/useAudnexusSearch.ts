import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BookMetadata } from '@/lib/api';

export interface UseAudnexusSearchOptions {
  /** Pre-populated results to show before the first search (e.g. from metadata matching) */
  initialResults?: BookMetadata[];
}

export interface UseAudnexusSearchResult {
  searchResults: BookMetadata[];
  hasSearched: boolean;
  searchError: string | null;
  isPending: boolean;
  search: (query: string) => void;
}

/**
 * Shared mutation hook for searching Audnexus metadata.
 * Used by BookEditModal and BookMetadataModal to avoid duplicating the
 * useMutation + state pattern.
 */
export function useAudnexusSearch(options?: UseAudnexusSearchOptions): UseAudnexusSearchResult {
  const [searchResults, setSearchResults] = useState<BookMetadata[]>(options?.initialResults ?? []);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (query: string) => api.searchMetadata(query),
    onSuccess: (result) => {
      setSearchResults(result.books);
      setHasSearched(true);
      setSearchError(null);
    },
    onError: () => {
      setSearchError('Search failed. Please try again.');
      setSearchResults([]);
      setHasSearched(true);
    },
  });

  const search = (query: string) => {
    if (query.trim()) {
      mutation.mutate(query.trim());
    }
  };

  return {
    searchResults,
    hasSearched,
    searchError,
    isPending: mutation.isPending,
    search,
  };
}
