import { useMemo } from 'react';
import type { useQueryClient } from '@tanstack/react-query';
import type { BookMetadata, AuthorMetadata, BookWithAuthor } from '@/lib/api';
import { bookMetadataKey, authorMetadataKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { SearchBookCard } from './SearchBookCard.js';
import { SearchAuthorCard } from './SearchAuthorCard.js';

export function BooksTabContent({
  books,
  libraryBooks,
  queryClient,
}: {
  books: BookMetadata[];
  libraryBooks: BookWithAuthor[] | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const keys = useMemo(() => deduplicateKeys(books.map(bookMetadataKey)), [books]);

  if (books.length === 0) {
    return <p className="text-center text-muted-foreground py-8">No books found</p>;
  }

  return (
    <div className="grid gap-4">
      {books.map((book, index) => (
        <SearchBookCard
          key={keys[index]}
          book={book}
          index={index}
          libraryBooks={libraryBooks}
          queryClient={queryClient}
        />
      ))}
    </div>
  );
}

export function AuthorsTabContent({ authors }: { authors: AuthorMetadata[] }) {
  const keys = useMemo(() => deduplicateKeys(authors.map(authorMetadataKey)), [authors]);

  if (authors.length === 0) {
    return <p className="text-center text-muted-foreground py-8">No authors found</p>;
  }

  return (
    <div className="grid gap-3">
      {authors.map((author, index) => (
        <SearchAuthorCard key={keys[index]} author={author} index={index} />
      ))}
    </div>
  );
}
