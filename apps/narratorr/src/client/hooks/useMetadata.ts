import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useMetadataSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.metadata.search(query),
    queryFn: () => api.searchMetadata(query),
    enabled: query.length >= 2,
    staleTime: 1000 * 60 * 5,
  });
}

export function useAuthor(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.metadata.author(id!),
    queryFn: () => api.getAuthor(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });
}

export function useAuthorBooks(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.metadata.authorBooks(id!),
    queryFn: () => api.getAuthorBooks(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });
}

export function useBook(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.metadata.book(id!),
    queryFn: () => api.getBook(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 5,
  });
}
