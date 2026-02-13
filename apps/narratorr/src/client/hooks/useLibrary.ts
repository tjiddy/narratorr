import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useLibrary() {
  return useQuery({
    queryKey: queryKeys.books(),
    queryFn: () => api.getBooks(),
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
