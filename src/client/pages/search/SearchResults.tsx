import { useState } from 'react';
import { type useQueryClient } from '@tanstack/react-query';
import { type BookMetadata, type AuthorMetadata } from '@/lib/api';
import { useBookIdentifiers } from '@/hooks/useLibrary';
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

  // Ownership source for the search cards (#1916). `/api/books` caps at
  // DEFAULT_LIMITS.books (120) ordered created-at-descending, so on a large
  // library an older exact-ASIN incumbent fell outside the page and the card
  // offered Add for a recording already owned. `useBookIdentifiers()` is the
  // unpaginated, status-blind identity list every other ownership surface in
  // the app already reads, and it shares one cache entry across pages —
  // don't reintroduce a page-local `useQuery` alongside it.
  //
  // Loading and failure are deliberately fail-open: `libraryBooks` stays
  // undefined, `findLibraryMatch` returns null, and the card shows Add. The
  // server's 409-with-incumbent verdict is the real duplicate backstop, so a
  // stale-or-absent hint can never create a duplicate — and blocking Add on an
  // ownership hint would be a worse regression than briefly over-offering it.
  const { data: libraryBooks } = useBookIdentifiers();

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
