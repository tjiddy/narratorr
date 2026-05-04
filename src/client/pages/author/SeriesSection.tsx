import { type BookMetadata, type BookWithAuthor, type BookIdentifier } from '@/lib/api';
import { isBookInLibrary } from '@/lib/helpers';
import { PlusIcon, LoadingSpinner, LibraryIcon } from '@/components/icons';
import { BookRow } from './BookRow.js';

export function SeriesSection({
  name,
  books,
  libraryBooks,
  onAddBook,
  onAddAll,
  addingAsins,
  isAddingAll,
}: {
  name: string;
  books: BookMetadata[];
  libraryBooks?: (BookIdentifier | BookWithAuthor)[] | undefined;
  onAddBook: (book: BookMetadata, overrides?: { searchImmediately: boolean; monitorForUpgrades: boolean }) => void;
  onAddAll: () => void;
  addingAsins: Set<string>;
  isAddingAll: boolean;
}) {
  const allInLibrary = books.every((b) => isBookInLibrary(b, libraryBooks));
  const booksNotInLibrary = books.filter((b) => !isBookInLibrary(b, libraryBooks));

  return (
    <div>
      {/* Series header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <LibraryIcon className="w-4 h-4 text-primary/70" />
          <h3 className="font-display text-lg font-semibold">{name}</h3>
          <span className="text-xs text-muted-foreground">
            {books.length} {books.length === 1 ? 'book' : 'books'}
          </span>
        </div>
        {!allInLibrary && (
          <button
            onClick={onAddAll}
            disabled={isAddingAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring disabled:opacity-50"
            title="Uses global quality defaults for Search immediately and Monitor for upgrades"
          >
            {isAddingAll ? (
              <LoadingSpinner className="w-3 h-3" />
            ) : (
              <PlusIcon className="w-3 h-3" />
            )}
            Add All ({booksNotInLibrary.length})
          </button>
        )}
      </div>

      {/* Book list */}
      <div className="glass-card rounded-2xl px-4 sm:px-5 divide-y divide-border/50">
        {books.map((book) => (
          <BookRow
            key={book.asin ?? book.title}
            book={book}
            inLibrary={isBookInLibrary(book, libraryBooks)}
            onAdd={(overrides) => onAddBook(book, overrides)}
            isAdding={addingAsins.has(book.asin ?? book.title)}
          />
        ))}
      </div>
    </div>
  );
}
