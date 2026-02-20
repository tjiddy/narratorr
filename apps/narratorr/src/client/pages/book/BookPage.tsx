import { useParams } from 'react-router-dom';
import { useBook } from '@/hooks/useMetadata';
import { useLibraryBook } from '@/hooks/useLibrary';
import { BookSkeleton } from './BookSkeleton.js';
import { BookNotFound } from './BookNotFound.js';
import { BookDetails } from './BookDetails.js';

export function BookPage() {
  const { id } = useParams<{ id: string }>();
  const numericId = id ? parseInt(id, 10) : undefined;

  const { data: libraryBook, isLoading, isError } = useLibraryBook(numericId);
  const { data: metadataBook } = useBook(libraryBook?.asin ?? undefined);

  if (isLoading) return <BookSkeleton />;
  if (isError || !libraryBook) return <BookNotFound />;

  return <BookDetails libraryBook={libraryBook} metadataBook={metadataBook} />;
}
