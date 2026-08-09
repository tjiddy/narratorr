import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useRetryImportAvailable(bookId: number, status: string): boolean {
  const { data } = useQuery({
    queryKey: ['book', bookId, 'retry-import-available'],
    queryFn: () => api.checkRetryImportAvailable(bookId),
    enabled: status === 'failed',
    staleTime: 30_000,
  });
  return status === 'failed' && data?.available === true;
}
