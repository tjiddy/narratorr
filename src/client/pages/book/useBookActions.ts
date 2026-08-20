import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type UpdateBookPayload, type RetagExcludableField, type RetagMode } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useFfmpegStatus } from '@/hooks/useFfmpegStatus';
import { getErrorMessage } from '@/lib/error-message.js';
import { describeKeptFiles } from '@/lib/kept-files-message.js';

/** #2435 AC19 — attach a manually-obtained file to this book. Its own hook so `useBookActions`
 * stays within the function-length rule rather than the rule being widened for it. */
function useImportFilesMutation(bookId: number, invalidateBookQueries: () => void) {
  return useMutation({
    mutationFn: (vars: { path: string; mode: 'copy' | 'move' }) => api.importBookFiles(bookId, vars),
    onSuccess: () => {
      invalidateBookQueries();
      toast.success('Import queued');
    },
    onError: (error: Error) => {
      // Surface the server's own refusal sentence — the route puts it in `error`, the field
      // `ApiError` prefers, so the toast names the condition that failed rather than its code.
      toast.error(`Import files failed: ${getErrorMessage(error)}`);
    },
  });
}

export function useBookActions(bookId: number) {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);

  const invalidateBookQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.book(bookId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.bookFiles(bookId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    // The series query uses singular `book`, so the `books` invalidations cannot reach it.
    queryClient.invalidateQueries({ queryKey: queryKeys.bookSeries(bookId) });
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
      // Completion/failure and cache invalidation are communicated via SSE; only toast queued here.
      if (result.status === 'queued') {
        toast.info(`Merge queued (position ${result.position})`);
      }
    },
    onError: (error: Error) => {
      // Pre-SSE API failures must surface here.
      toast.error(`Merge failed: ${getErrorMessage(error)}`);
    },
  });

  const retagMutation = useMutation({
    mutationFn: (vars?: { excludeFields?: RetagExcludableField[]; mode?: RetagMode; embedCover?: boolean }) => api.retagBook(bookId, vars),
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
      toast.success('Refreshed audio metadata');
    },
    onError: (error: Error) => {
      toast.error(`Refresh scan failed: ${getErrorMessage(error)}`);
    },
    // The route reconciles the companion ebook before NO_AUDIO_FILES throws, so invalidate on settled.
    onSettled: () => {
      invalidateBookQueries();
    },
  });

  const ffmpegStatus = useFfmpegStatus();
  // Assume the normal Docker install while loading, but fail closed on detection errors.
  const ffmpegConfigured = ffmpegStatus.isError ? false : ffmpegStatus.data?.detected !== false;

  const deleteMutation = useMutation({
    mutationFn: ({ deleteFiles }: { deleteFiles: boolean }) =>
      api.deleteBook(bookId, deleteFiles ? { deleteFiles: true } : undefined),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      if (!variables.deleteFiles) {
        toast.success('Removed book from library');
        return;
      }
      const kept = describeKeptFiles(data.fileSummary?.preservedForeign);
      toast.success(kept ? `Removed book and deleted files from disk — ${kept}` : 'Removed book and deleted files from disk');
    },
    onError: (error: Error) => {
      toast.error(`Failed to remove book: ${getErrorMessage(error)}`);
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

  const importFilesMutation = useImportFilesMutation(bookId, invalidateBookQueries);

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
    wrongReleaseMutation,
    retryImportMutation,
    importFilesMutation,
    uploadCoverMutation,
    ffmpegConfigured,
    isSaving,
    handleSave,
  };
}
