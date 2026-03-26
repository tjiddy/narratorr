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
      invalidateBookQueries();
      toast.success(result.message);
    },
    onError: (error: Error) => {
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
        } catch (renameError) {
          toast.error(`Rename failed: ${renameError instanceof Error ? renameError.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      toast.error(`Failed to update book: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  return {
    renameMutation,
    mergeMutation,
    retagMutation,
    monitorMutation,
    ffmpegConfigured,
    isSaving,
    handleSave,
  };
}
