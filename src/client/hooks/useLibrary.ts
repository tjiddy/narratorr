import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useLibrary() {
  const query = useQuery({
    queryKey: queryKeys.books(),
    queryFn: () => api.getBooks(),
    staleTime: 30_000,
    select: (response) => response.data,
  });
  return query;
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
