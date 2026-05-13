import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SUPPORTED_COVER_MIMES } from '../../shared/mime.js';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import type { UseMutationResult } from '@tanstack/react-query';
import type { BookWithAuthor } from '@/lib/api';

interface UseCoverDraftResult {
  previewUrl: string | null;
  handleCoverFile: (file: File) => void;
  handleCoverConfirm: () => void;
  handleCoverCancel: () => void;
}

export function useCoverDraft(
  uploadCoverMutation: UseMutationResult<BookWithAuthor, Error, File>,
): UseCoverDraftResult {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  const handleCoverFile = useCallback((nextFile: File) => {
    if (!SUPPORTED_COVER_MIMES.has(nextFile.type)) {
      toast.error('Only JPG, PNG, and WebP images are supported');
      return;
    }
    if (nextFile.size > MAX_COVER_SIZE) {
      toast.error('Cover image must be under 10 MB');
      return;
    }
    setFile(nextFile);
    setPreviewUrl(URL.createObjectURL(nextFile));
  }, []);

  const handleCoverConfirm = useCallback(() => {
    if (!file) return;
    uploadCoverMutation.mutate(file, {
      onSuccess: () => {
        setPreviewUrl(null);
        setFile(null);
      },
    });
  }, [file, uploadCoverMutation]);

  const handleCoverCancel = useCallback(() => {
    setPreviewUrl(null);
    setFile(null);
  }, []);

  // Single owner of blob URL lifecycle — revokes on every change and unmount.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return { previewUrl, handleCoverFile, handleCoverConfirm, handleCoverCancel };
}
