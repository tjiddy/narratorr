import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, readAddBookConflict, formatReviewConflictMessage, type BookMetadata, type LibraryEntry } from '@/lib/api';
import { mapBookMetadataToPayload, isBookInLibrary } from '@/lib/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

export interface QualityDefaults {
  searchImmediately: boolean;
}

export function useAddBooksToLibrary(libraryBooks?: LibraryEntry[], qualityDefaults?: QualityDefaults) {
  const queryClient = useQueryClient();
  const [addingAsins, setAddingAsins] = useState<Set<string>>(new Set());
  const [addedAsins, setAddedAsins] = useState<Set<string>>(new Set());

  const addBookMutation = useMutation({
    mutationFn: ({ book, overrides }: { book: BookMetadata; overrides?: QualityDefaults }) => {
      const key = book.asin ?? book.title;
      setAddingAsins((prev) => new Set(prev).add(key));
      return api.addBook(mapBookMetadataToPayload(book, overrides ?? qualityDefaults));
    },
    onSuccess: (_data, { book }) => {
      const key = book.asin ?? book.title;
      setAddingAsins((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setAddedAsins((prev) => new Set(prev).add(key));
      toast.success(`Added '${book.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error, { book }) => {
      const key = book.asin ?? book.title;
      setAddingAsins((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      const details = readAddBookConflict(error);
      if (details) {
        // Review is tested FIRST and ownership is the fallthrough: a null discriminator degrading
        // into the review arm would silently drop a real ownership claim. `review` is the server
        // abstaining; claiming the key would strand the book behind an Add control it can never
        // re-enable.
        if (details.conflict === 'review') {
          toast.info(formatReviewConflictMessage(details.incumbentTitle));
          return;
        }
        setAddedAsins((prev) => new Set(prev).add(key));
        toast.info('Already in library');
        queryClient.invalidateQueries({ queryKey: queryKeys.books() });
        return;
      }
      toast.error(`Failed to add '${book.title}': ${getErrorMessage(error)}`);
    },
  });

  const isBookAdded = useCallback((book: BookMetadata): boolean => {
    const key = book.asin ?? book.title;
    return addedAsins.has(key) || isBookInLibrary(book, libraryBooks);
  }, [addedAsins, libraryBooks]);

  const addBook = useCallback((book: BookMetadata, overrides?: QualityDefaults) => {
    if (!isBookAdded(book)) {
      addBookMutation.mutate({ book, ...(overrides !== undefined && { overrides }) });
    }
  }, [isBookAdded, addBookMutation]);

  const addAllInSeries = useCallback((books: BookMetadata[]) => {
    const toAdd = books.filter((b) => !isBookAdded(b));
    for (const book of toAdd) {
      addBookMutation.mutate({ book });
    }
  }, [isBookAdded, addBookMutation]);

  return {
    addingAsins,
    isBookAdded,
    addBook,
    addAllInSeries,
  };
}
