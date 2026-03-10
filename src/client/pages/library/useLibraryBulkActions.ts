import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type BookWithAuthor, type SingleBookSearchResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useLibraryBulkActions(visibleBooks: BookWithAuthor[]) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Intersect selection with visible books so filtered-out books are excluded
  const visibleBookIds = useMemo(() => new Set(visibleBooks.map((b) => b.id)), [visibleBooks]);
  const effectiveSelectedIds = useMemo(() => {
    const intersection = new Set<number>();
    for (const id of selectedIds) {
      if (visibleBookIds.has(id)) intersection.add(id);
    }
    return intersection;
  }, [selectedIds, visibleBookIds]);

  const selectedBooks = visibleBooks.filter((b) => effectiveSelectedIds.has(b.id));

  const bulkDeleteMutation = useMutation({
    mutationFn: async ({ deleteFiles }: { deleteFiles: boolean }) => {
      const results = await Promise.allSettled(
        selectedBooks.map((b) => api.deleteBook(b.id, deleteFiles ? { deleteFiles: true } : undefined)),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      return { succeeded, failed, total: results.length };
    },
    onSuccess: ({ succeeded, failed, total }) => {
      if (failed === 0) {
        toast.success(`Deleted ${succeeded} book${succeeded !== 1 ? 's' : ''}`);
      } else if (succeeded === 0) {
        const firstError = 'All deletions failed';
        toast.error(firstError);
      } else {
        toast.success(`Deleted ${succeeded} of ${total} books — ${failed} failed`);
      }
      clearSelection();
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error) => {
      toast.error(`Bulk delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });

  const bulkSearchMutation = useMutation({
    mutationFn: async () => {
      const wantedBooks = selectedBooks.filter((b) => b.status === 'wanted');
      const skippedNonWanted = selectedBooks.length - wantedBooks.length;

      if (wantedBooks.length === 0) {
        return { grabbed: 0, skipped: skippedNonWanted, failed: 0, searched: 0 };
      }

      const results = await Promise.allSettled(
        wantedBooks.map((b) => api.searchBook(b.id)),
      );

      let grabbed = 0;
      let skipped = skippedNonWanted;
      let failed = 0;

      for (const result of results) {
        if (result.status === 'rejected') {
          failed++;
          continue;
        }
        const val = result.value as SingleBookSearchResult;
        if (val.result === 'grabbed') grabbed++;
        else if (val.result === 'skipped') skipped++;
        else failed++; // no_results counts as failed
      }

      return { grabbed, skipped, failed, searched: wantedBooks.length };
    },
    onSuccess: ({ grabbed, skipped, failed, searched }) => {
      if (searched === 0) {
        toast.info('No wanted books selected');
        return;
      }
      const parts = [`Searched ${searched} book${searched !== 1 ? 's' : ''}`];
      if (grabbed > 0) parts.push(`${grabbed} grabbed`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      if (failed > 0) parts.push(`${failed} failed`);
      toast.success(parts.join(', '));
      clearSelection();
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
    onError: (error) => {
      toast.error(`Bulk search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });

  const bulkSetStatusMutation = useMutation({
    mutationFn: async ({ status, label }: { status: string; label: string }) => {
      const results = await Promise.allSettled(
        selectedBooks.map((b) => api.updateBook(b.id, { status } as Record<string, unknown>)),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      return { succeeded, total: results.length, label };
    },
    onSuccess: ({ succeeded, total, label }) => {
      toast.success(`Updated ${succeeded} of ${total} books to ${label}`);
      clearSelection();
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error) => {
      toast.error(`Bulk status update failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });

  return {
    selectedIds: effectiveSelectedIds,
    setSelectedIds,
    selectedBooks,
    clearSelection,
    bulkDeleteMutation,
    bulkSearchMutation,
    bulkSetStatusMutation,
  };
}
