import { useState } from 'react';
import { useQuery, type useQueryClient } from '@tanstack/react-query';
import { api, type BookMetadata, type AuthorMetadata } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { BookOpenIcon, UsersIcon, SearchIcon } from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';
import { BooksTabContent, AuthorsTabContent } from './SearchTabContent.js';

type DiscoverTab = 'books' | 'authors';

export function SearchResults({
  results,
  searchTerm,
  isLoading,
  queryClient,
}: {
  results: { books: BookMetadata[]; authors: AuthorMetadata[] } | undefined;
  searchTerm: string;
  isLoading: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [tab, setTab] = useState<DiscoverTab>('books');
  const hasResults = results && (results.authors.length > 0 || results.books.length > 0);

  const { data: libraryBooks } = useQuery({
    queryKey: queryKeys.books(),
    queryFn: () => api.getBooks(),
  });

  if (searchTerm && !isLoading && !hasResults) {
    return (
      <EmptyState
        icon={<SearchIcon className="w-12 h-12" />}
        title={`No results for "${searchTerm}"`}
        description="Try different keywords or check the spelling"
      />
    );
  }

  if (!searchTerm) {
    return (
      <EmptyState
        icon={<BookOpenIcon className="w-16 h-16" />}
        title="Start your search"
        description="Enter a title, author, or series to discover audiobooks"
      />
    );
  }

  if (!results) return null;

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex justify-center animate-fade-in">
        <div className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
          <button
            onClick={() => setTab('books')}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${tab === 'books'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'}
            `}
          >
            <BookOpenIcon className="w-4 h-4" />
            Books
            {results.books.length > 0 && (
              <span className="text-xs opacity-75">({results.books.length})</span>
            )}
          </button>
          <button
            onClick={() => setTab('authors')}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${tab === 'authors'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'}
            `}
          >
            <UsersIcon className="w-4 h-4" />
            Authors
            {results.authors.length > 0 && (
              <span className="text-xs opacity-75">({results.authors.length})</span>
            )}
          </button>
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'books' && (
        <BooksTabContent books={results.books} libraryBooks={libraryBooks} queryClient={queryClient} />
      )}
      {tab === 'authors' && (
        <AuthorsTabContent authors={results.authors} />
      )}
    </div>
  );
}
