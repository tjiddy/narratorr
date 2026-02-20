import { useMemo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BookWithAuthor } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useImportPolling(books: BookWithAuthor[]) {
  const queryClient = useQueryClient();

  const importingCount = useMemo(() => books.filter(b => b.status === 'importing').length, [books]);
  const prevImportingRef = useRef(0);

  // Toast when all imports finish
  useEffect(() => {
    if (prevImportingRef.current > 0 && importingCount === 0) {
      toast.success('Import complete');
    }
    prevImportingRef.current = importingCount;
  }, [importingCount]);

  // Refetch more frequently when books are importing
  useEffect(() => {
    if (importingCount === 0) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    }, 3000);
    return () => clearInterval(interval);
  }, [importingCount, queryClient]);
}
