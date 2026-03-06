import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type BookMetadata, type BookWithAuthor } from '@/lib/api';
import { mapBookMetadataToPayload, isBookInLibrary } from '@/lib/helpers';
import { queryKeys } from '@/lib/queryKeys';

export interface QualityDefaults {
  searchImmediately: boolean;
  monitorForUpgrades: boolean;
}

export function useAddBooksToLibrary(libraryBooks?: BookWithAuthor[], qualityDefaults?: QualityDefaults) {
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
      toast.error(`Failed to add '${book.title}': ${error.message}`);
    },
  });

  const isBookAdded = useCallback((book: BookMetadata): boolean => {
    const key = book.asin ?? book.title;
    return addedAsins.has(key) || isBookInLibrary(book, libraryBooks);
  }, [addedAsins, libraryBooks]);

  const addBook = useCallback((book: BookMetadata, overrides?: QualityDefaults) => {
    if (!isBookAdded(book)) {
      addBookMutation.mutate({ book, overrides });
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
