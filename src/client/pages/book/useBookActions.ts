import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type UpdateBookPayload, type RetagExcludableField } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';

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
      toast.error(`Rename failed: ${getErrorMessage(error)}`);
    },
  });

  const mergeMutation = useMutation({
    mutationFn: () => api.mergeBookToM4b(bookId),
    onSuccess: (result) => {
      // Route now returns 202 acknowledgement. Completion/failure communicated via SSE.
      if (result.status === 'queued') {
        toast.info(`Merge queued (position ${result.position})`);
      }
      // No toast for 'started' — SSE merge_started handles that.
      // No invalidateBookQueries() — SSE merge_complete cache rules handle invalidation.
      // No enrichmentWarning — moved to SSE merge_complete event handler in useEventSource.
    },
    onError: (error: Error) => {
      // API-level failures (e.g., 409 ALREADY_IN_PROGRESS) happen before SSE events fire,
      // so the mutation must handle these directly.
      toast.error(`Merge failed: ${getErrorMessage(error)}`);
    },
  });

  const retagMutation = useMutation({
    mutationFn: (vars?: { excludeFields?: RetagExcludableField[] }) => api.retagBook(bookId, vars),
    onSuccess: (result) => {
      const msg = `Tagged ${result.tagged} file${result.tagged !== 1 ? 's' : ''}`;
      if (result.failed > 0) {
        toast.warning(`${msg}, ${result.failed} failed`);
      } else {
        toast.success(msg);
      }
    },
    onError: (error: Error) => {
      toast.error(`Re-tag failed: ${getErrorMessage(error)}`);
    },
  });

  const refreshScanMutation = useMutation({
    mutationFn: () => api.refreshScanBook(bookId),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success('Refreshed audio metadata');
    },
    onError: (error: Error) => {
      toast.error(`Refresh scan failed: ${getErrorMessage(error)}`);
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
      toast.error(`Failed to remove book: ${getErrorMessage(error)}`);
    },
  });

  const monitorMutation = useMutation({
    mutationFn: () => api.updateBook(bookId, { monitorForUpgrades: !monitorForUpgrades }),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success(monitorForUpgrades ? 'Upgrade monitoring disabled' : 'Upgrade monitoring enabled');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update: ${getErrorMessage(error)}`);
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
          toast.error(`Rename failed: ${getErrorMessage(renameError)}`);
        }
      }
    } catch (error: unknown) {
      toast.error(`Failed to update book: ${getErrorMessage(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const uploadCoverMutation = useMutation({
    mutationFn: (file: File) => api.uploadBookCover(bookId, file),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success('Cover updated');
    },
    onError: (error: Error) => {
      toast.error(`Cover upload failed: ${getErrorMessage(error)}`);
    },
  });

  const cancelMergeMutation = useMutation({
    mutationFn: () => api.cancelMergeBook(bookId),
    onError: (error: Error) => {
      toast.error(`Cancel merge failed: ${getErrorMessage(error)}`);
    },
  });

  const wrongReleaseMutation = useMutation({
    mutationFn: () => api.markBookAsWrongRelease(bookId),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success('Book marked as wrong release — searching for replacement');
    },
    onError: (error: Error) => {
      toast.error(`Wrong release failed: ${getErrorMessage(error)}`);
    },
  });

  const retryImportMutation = useMutation({
    mutationFn: () => api.retryBookImport(bookId),
    onSuccess: () => { invalidateBookQueries(); toast.success('Import retry queued'); },
    onError: (error: Error) => { toast.error(`Retry import failed: ${getErrorMessage(error)}`); },
  });

  return {
    renameMutation,
    mergeMutation,
    cancelMergeMutation,
    retagMutation,
    refreshScanMutation,
    deleteMutation,
    monitorMutation,
    wrongReleaseMutation,
    retryImportMutation,
    uploadCoverMutation,
    ffmpegConfigured,
    isSaving,
    handleSave,
  };
}
