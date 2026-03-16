import { useQuery } from '@tanstack/react-query';
import { api, type BookListParams } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useLibrary(params?: BookListParams) {
  return useQuery({
    queryKey: queryKeys.books(params),
    queryFn: () => api.getBooks(params),
    staleTime: 30_000,
  });
}

export function useBookIdentifiers() {
  return useQuery({
    queryKey: queryKeys.bookIdentifiers(),
    queryFn: () => api.getBookIdentifiers(),
    staleTime: 30_000,
  });
}

export function useBookStats() {
  return useQuery({
    queryKey: queryKeys.bookStats(),
    queryFn: () => api.getBookStats(),
    staleTime: 30_000,
  });
}

export function useLibraryBook(id: number | undefined) {
  return useQuery({
    queryKey: queryKeys.book(id!),
    queryFn: () => api.getBookById(id!),
    enabled: id != null && !isNaN(id),
    staleTime: 30_000,
  });
}

export function useBookFiles(id: number | undefined) {
  return useQuery({
    queryKey: queryKeys.bookFiles(id!),
    queryFn: () => api.getBookFiles(id!),
    enabled: id != null && !isNaN(id),
    staleTime: 5 * 60_000,
  });
}
