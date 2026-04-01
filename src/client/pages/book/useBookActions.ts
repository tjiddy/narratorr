import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type UpdateBookPayload } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useBookActions(bookId: number, monitorForUpgrades: boolean) {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  const invalidateBookQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.bookFiles(bookId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.books() });
  };

  const renameMutation = useMutation({
    mutationFn: () => api.renameBook(bookId),
    onSuccess: (result) => {
      invalidateBookQueries();
      toast.success(result.message);
    },
    onError: (error: Error) => {
      toast.error(`Rename failed: ${error.message}`);
    },
  });

  const mergeMutation = useMutation({
    mutationFn: () => api.mergeBookToM4b(bookId),
    onSuccess: (result) => {
      // Success/failure toasts are driven by SSE events (merge_started, merge_complete, merge_failed)
      // to ensure all users see notifications, not just the initiator.
      invalidateBookQueries();
      if (result.enrichmentWarning) {
        toast.warning(result.enrichmentWarning);
      }
    },
    onError: (error: Error) => {
      // API-level failures (e.g., 409 ALREADY_IN_PROGRESS) happen before SSE events fire,
      // so the mutation must handle these directly.
      toast.error(`Merge failed: ${error.message}`);
    },
  });

  const retagMutation = useMutation({
    mutationFn: () => api.retagBook(bookId),
    onSuccess: (result) => {
      const msg = `Tagged ${result.tagged} file${result.tagged !== 1 ? 's' : ''}`;
      if (result.failed > 0) {
        toast.warning(`${msg}, ${result.failed} failed`);
      } else {
        toast.success(msg);
      }
    },
    onError: (error: Error) => {
      toast.error(`Re-tag failed: ${error.message}`);
    },
  });

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const ffmpegConfigured = !!settings?.processing?.ffmpegPath?.trim();

  const deleteMutation = useMutation({
    mutationFn: ({ deleteFiles }: { deleteFiles: boolean }) =>
      api.deleteBook(bookId, deleteFiles ? { deleteFiles: true } : undefined),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      toast.success(variables.deleteFiles ? 'Removed book and deleted files from disk' : 'Removed book from library');
    },
    onError: (error: Error) => {
      toast.error(`Failed to remove book: ${error.message}`);
    },
  });

  const monitorMutation = useMutation({
    mutationFn: () => api.updateBook(bookId, { monitorForUpgrades: !monitorForUpgrades }),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success(monitorForUpgrades ? 'Upgrade monitoring disabled' : 'Upgrade monitoring enabled');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update: ${error.message}`);
    },
  });

  const handleSave = async (data: UpdateBookPayload, renameFiles: boolean, onSuccess?: () => void) => {
    setIsSaving(true);
    try {
      await api.updateBook(bookId, data);
      invalidateBookQueries();
      onSuccess?.();
      toast.success('Metadata updated');

      if (renameFiles) {
        try {
          const renameResult = await api.renameBook(bookId);
          invalidateBookQueries();
          toast.success(renameResult.message);
        } catch (renameError: unknown) {
          toast.error(`Rename failed: ${renameError instanceof Error ? renameError.message : 'Unknown error'}`);
        }
      }
    } catch (error: unknown) {
      toast.error(`Failed to update book: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  const wrongReleaseMutation = useMutation({
    mutationFn: () => api.markBookAsWrongRelease(bookId),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success('Book marked as wrong release — searching for replacement');
    },
    onError: (error: Error) => {
      toast.error(`Wrong release failed: ${error.message}`);
    },
  });

  return {
    renameMutation,
    mergeMutation,
    retagMutation,
    deleteMutation,
    monitorMutation,
    wrongReleaseMutation,
    ffmpegConfigured,
    isSaving,
    handleSave,
  };
}
