import { useState } from 'react';
import { useQuery, type useQueryClient } from '@tanstack/react-query';
import { api, type BookMetadata, type AuthorMetadata } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { BookOpenIcon, UsersIcon } from '@/components/icons';
import { Tabs, type TabItem } from '@/components/Tabs.js';
import { BooksTabContent, AuthorsTabContent } from './SearchTabContent.js';

type DiscoverTab = 'books' | 'authors';

export function SearchResults({
  results,
  searchTerm,
  queryClient,
}: {
  results: { books: BookMetadata[]; authors: AuthorMetadata[] } | undefined;
  searchTerm: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [tab, setTab] = useState<DiscoverTab>('books');
  const hasResults = results && (results.authors.length > 0 || results.books.length > 0);

  const { data: libraryBooks } = useQuery({
    queryKey: queryKeys.books(),
    queryFn: () => api.getBooks(),
    select: (response) => response.data,
  });

  if (!searchTerm) {
    return null;
  }

  if (!results) return null;

  const searchTabs: TabItem[] = [
    {
      value: 'books',
      label: 'Books',
      icon: <BookOpenIcon className="w-4 h-4" />,
      ...(results.books.length > 0 && { badge: `(${results.books.length})` }),
    },
    {
      value: 'authors',
      label: 'Authors',
      icon: <UsersIcon className="w-4 h-4" />,
      ...(results.authors.length > 0 && { badge: `(${results.authors.length})` }),
    },
  ];

  return (
    <div className="space-y-6">
      {hasResults && (
        <div className="flex justify-center animate-fade-in">
          <Tabs tabs={searchTabs} value={tab} onChange={(v) => setTab(v as DiscoverTab)} ariaLabel="Search results" />
        </div>
      )}

      {tab === 'books' && (
        <div role="tabpanel" id="tabpanel-books" aria-labelledby="tab-books">
          <BooksTabContent books={results.books} libraryBooks={libraryBooks} queryClient={queryClient} searchTerm={searchTerm} />
        </div>
      )}
      {tab === 'authors' && hasResults && (
        <div role="tabpanel" id="tabpanel-authors" aria-labelledby="tab-authors">
          <AuthorsTabContent authors={results.authors} />
        </div>
      )}
    </div>
  );
}
