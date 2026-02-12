import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useLibrary() {
  return useQuery({
    queryKey: ['books'],
    queryFn: () => api.getBooks(),
    staleTime: 30_000,
  });
}
