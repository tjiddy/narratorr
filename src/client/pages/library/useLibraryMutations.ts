import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

export function useLibraryMutations() {
  const queryClient = useQueryClient();

  const rescanMutation = useMutation({
    mutationFn: () => api.rescanLibrary(),
    onSuccess: (data) => {
      toast.success(`Scanned: ${data.scanned} books. Missing: ${data.missing} books. Restored: ${data.restored} books.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error) => {
      toast.error(getErrorMessage(error, 'Rescan failed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) =>
      api.deleteBook(id, deleteFiles ? { deleteFiles: true } : undefined),
    onSuccess: (_data, variables) => {
      toast.success(variables.deleteFiles ? 'Removed book and deleted files from disk' : 'Removed book from library');
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error) => {
      toast.error(getErrorMessage(error, 'Failed to remove book'));
    },
  });

  const deleteMissingMutation = useMutation({
    mutationFn: () => api.deleteMissingBooks(),
    onSuccess: (data) => {
      toast.success(`Removed ${data.deleted} missing book${data.deleted !== 1 ? 's' : ''}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error) => {
      toast.error(getErrorMessage(error, 'Failed to remove missing books'));
    },
  });

  const searchAllWantedMutation = useMutation({
    mutationFn: () => api.searchAllWanted(),
    onSuccess: (data) => {
      const parts = [`${data.searched} searched`, `${data.grabbed} grabbed`];
      if (data.skipped > 0) parts.push(`${data.skipped} skipped`);
      if (data.errors > 0) parts.push(`${data.errors} errors`);
      toast.success(`Search complete: ${parts.join(', ')}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
    onError: (error: Error) => {
      toast.error(getErrorMessage(error, 'Search all wanted failed'));
    },
  });

  return { rescanMutation, deleteMutation, deleteMissingMutation, searchAllWantedMutation };
}
