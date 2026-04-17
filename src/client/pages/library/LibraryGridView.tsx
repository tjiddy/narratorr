import type { BookWithAuthor } from '@/lib/api';
import type { DisplayBook } from './helpers.js';
import { LibraryBookCard } from './LibraryBookCard.js';

export interface LibraryGridViewProps {
  displayBooks: DisplayBook[];
  settledGridKey: string;
  openMenuId: number | null;
  onMenuToggle: (bookId: number, e: React.MouseEvent) => void;
  onMenuClose: () => void;
  onClick: (bookId: number) => void;
  onSearchReleases: (book: BookWithAuthor) => void;
  onRemove: (book: BookWithAuthor) => void;
  onRetryImport?: (book: BookWithAuthor) => void;
}

export function LibraryGridView({
  displayBooks,
  settledGridKey,
  openMenuId,
  onMenuToggle,
  onMenuClose,
  onClick,
  onSearchReleases,
  onRemove,
  onRetryImport,
}: LibraryGridViewProps) {
  return (
    <div key={settledGridKey} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
      {displayBooks.map((book: DisplayBook, index) => (
        <LibraryBookCard
          key={book.id}
          book={book}
          index={index}
          collapsedCount={book.collapsedCount}
          isMenuOpen={openMenuId === book.id}
          onMenuToggle={onMenuToggle}
          onMenuClose={onMenuClose}
          onClick={onClick}
          onSearchReleases={onSearchReleases}
          onRemove={onRemove}
          onRetryImport={onRetryImport}
        />
      ))}
    </div>
  );
}
