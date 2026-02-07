import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useMetadataSearch(query: string) {
  return useQuery({
    queryKey: ['metadata', 'search', query],
    queryFn: () => api.searchMetadata(query),
    enabled: query.length >= 2,
    staleTime: 1000 * 60 * 5,
  });
}

export function useAuthor(asin: string | undefined) {
  return useQuery({
    queryKey: ['metadata', 'author', asin],
    queryFn: () => api.getAuthor(asin!),
    enabled: !!asin,
    staleTime: 1000 * 60 * 5,
  });
}

export function useAuthorBooks(asin: string | undefined) {
  return useQuery({
    queryKey: ['metadata', 'authorBooks', asin],
    queryFn: () => api.getAuthorBooks(asin!),
    enabled: !!asin,
    staleTime: 1000 * 60 * 5,
  });
}

export function useBook(asin: string | undefined) {
  return useQuery({
    queryKey: ['metadata', 'book', asin],
    queryFn: () => api.getBook(asin!),
    enabled: !!asin,
    staleTime: 1000 * 60 * 5,
  });
}
