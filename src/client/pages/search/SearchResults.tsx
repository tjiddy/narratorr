import { useRef, useState } from 'react';
import { useQuery, type useQueryClient } from '@tanstack/react-query';
import { api, type BookMetadata, type AuthorMetadata } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { BookOpenIcon, UsersIcon } from '@/components/icons';
import { BooksTabContent, AuthorsTabContent } from './SearchTabContent.js';

type DiscoverTab = 'books' | 'authors';

function getArrowTabIndex(key: string, currentIndex: number, length: number): number | null {
  if (key === 'ArrowRight') return (currentIndex + 1) % length;
  if (key === 'ArrowLeft') return (currentIndex - 1 + length) % length;
  return null;
}

function SearchTabBar({ tab, onTabChange, bookCount, authorCount }: {
  tab: DiscoverTab;
  onTabChange: (t: DiscoverTab) => void;
  bookCount: number;
  authorCount: number;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabKeys = ['books', 'authors'] as const;

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    const nextIndex = getArrowTabIndex(e.key, tabKeys.indexOf(tab), tabKeys.length);
    if (nextIndex !== null) {
      e.preventDefault();
      onTabChange(tabKeys[nextIndex]);
      tabRefs.current[nextIndex]?.focus();
    }
  }

  return (
    <div className="flex justify-center animate-fade-in">
      <div role="tablist" aria-label="Search results" className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
        <button
          ref={(el) => { tabRefs.current[0] = el; }}
          id="tab-books"
          role="tab"
          aria-selected={tab === 'books'}
          aria-controls="tabpanel-books"
          tabIndex={tab === 'books' ? 0 : -1}
          onClick={() => onTabChange('books')}
          onKeyDown={handleKeyDown}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
            ${tab === 'books'
              ? 'bg-primary text-primary-foreground shadow-glow'
              : 'text-muted-foreground hover:text-foreground'}
          `}
        >
          <BookOpenIcon className="w-4 h-4" />
          Books
          {bookCount > 0 && (
            <span className="text-xs opacity-75">({bookCount})</span>
          )}
        </button>
        <button
          ref={(el) => { tabRefs.current[1] = el; }}
          id="tab-authors"
          role="tab"
          aria-selected={tab === 'authors'}
          aria-controls="tabpanel-authors"
          tabIndex={tab === 'authors' ? 0 : -1}
          onClick={() => onTabChange('authors')}
          onKeyDown={handleKeyDown}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
            ${tab === 'authors'
              ? 'bg-primary text-primary-foreground shadow-glow'
              : 'text-muted-foreground hover:text-foreground'}
          `}
        >
          <UsersIcon className="w-4 h-4" />
          Authors
          {authorCount > 0 && (
            <span className="text-xs opacity-75">({authorCount})</span>
          )}
        </button>
      </div>
    </div>
  );
}

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
    select: (response) => response.data,
  });

  if (!searchTerm || (searchTerm && !isLoading && !hasResults)) {
    return null;
  }

  if (!results) return null;

  return (
    <div className="space-y-6">
      <SearchTabBar
        tab={tab}
        onTabChange={setTab}
        bookCount={results.books.length}
        authorCount={results.authors.length}
      />

      {tab === 'books' && (
        <div role="tabpanel" id="tabpanel-books" aria-labelledby="tab-books">
          <BooksTabContent books={results.books} libraryBooks={libraryBooks} queryClient={queryClient} />
        </div>
      )}
      {tab === 'authors' && (
        <div role="tabpanel" id="tabpanel-authors" aria-labelledby="tab-authors">
          <AuthorsTabContent authors={results.authors} />
        </div>
      )}
    </div>
  );
}
