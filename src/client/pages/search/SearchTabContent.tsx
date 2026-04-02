import { useMemo, useState } from 'react';
import type { useQueryClient } from '@tanstack/react-query';
import type { BookMetadata, AuthorMetadata, BookWithAuthor } from '@/lib/api';
import { bookMetadataKey, authorMetadataKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { SearchBookCard } from './SearchBookCard.js';
import { SearchAuthorCard } from './SearchAuthorCard.js';
import { ManualAddFormModal } from '@/components/ManualAddFormModal';

export function BooksTabContent({
  books,
  libraryBooks,
  queryClient,
  searchTerm,
}: {
  books: BookMetadata[];
  libraryBooks: BookWithAuthor[] | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
  searchTerm?: string;
}) {
  const keys = useMemo(() => deduplicateKeys(books.map(bookMetadataKey)), [books]);
  const [showModal, setShowModal] = useState(false);
  const [modalDefaultTitle, setModalDefaultTitle] = useState<string | undefined>();

  const openModal = (defaultTitle?: string) => {
    setModalDefaultTitle(defaultTitle);
    setShowModal(true);
  };

  if (books.length === 0) {
    return (
      <div className="space-y-6">
        <p className="text-center text-muted-foreground py-8">No books found</p>
        <p className="text-center">
          <button
            type="button"
            onClick={() => openModal(searchTerm)}
            className="px-6 py-3 bg-primary text-primary-foreground rounded-xl font-medium transition-all hover:bg-primary/90"
          >
            Add manually
          </button>
        </p>
        <ManualAddFormModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          defaultTitle={modalDefaultTitle}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
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

      <p className="text-center py-4">
        <button
          type="button"
          onClick={() => openModal(undefined)}
          className="text-muted-foreground hover:text-primary transition-colors text-sm"
        >
          Can&apos;t find it? <span className="underline">Add manually</span>
        </button>
      </p>

      <ManualAddFormModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        defaultTitle={modalDefaultTitle}
      />
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
