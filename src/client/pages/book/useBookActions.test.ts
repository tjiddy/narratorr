import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useBookActions } from './useBookActions.js';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const actualApi = (actual as { api: Record<string, unknown> }).api;
  return {
    ...actual,
    api: {
      ...actualApi,
      updateBook: vi.fn(),
      renameBook: vi.fn(),
      retagBook: vi.fn(),
      mergeBookToM4b: vi.fn(),
      markBookAsWrongRelease: vi.fn(),
      deleteBook: vi.fn(),
      uploadBookCover: vi.fn(),
      refreshScanBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        processing: { ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2 },
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
        search: { intervalMinutes: 360, enabled: true, blacklistTtlDays: 7 },
        import: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5 },
        general: { logLevel: 'info', housekeepingRetentionDays: 90 },
        metadata: { audibleRegion: 'us' },
        tagging: { enabled: false, mode: 'populate_missing', embedCover: false },
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, rejectWords: '', requiredWords: '' },
        network: {},
        rss: { intervalMinutes: 15, enabled: false },
      }),
    },
  };
});

function createTestHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
  return { queryClient, wrapper };
}

describe('useBookActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleSave', () => {
    it('calls onSuccess callback after successful metadata update', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      const onSuccess = vi.fn();

      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'New Title' }, false, onSuccess);
      });

      expect(onSuccess).toHaveBeenCalledOnce();
      expect(toast.success).toHaveBeenCalledWith('Metadata updated');
    });

    it('does not call onSuccess when metadata update fails', async () => {
      (api.updateBook as Mock).mockRejectedValue(new Error('Network error'));
      const onSuccess = vi.fn();

      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'New Title' }, false, onSuccess);
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Failed to update book: Network error');
    });

    it('shows error toast when metadata update rejects with non-Error', async () => {
      (api.updateBook as Mock).mockRejectedValue('string error');

      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to update book: string error');
    });

    it('resets isSaving after failure', async () => {
      (api.updateBook as Mock).mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      expect(result.current.isSaving).toBe(false);

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(result.current.isSaving).toBe(false);
    });

    it('attempts rename after successful save when renameFiles is true', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockResolvedValue({ message: 'Renamed', filesRenamed: 1 });

      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, true);
      });

      expect(api.renameBook).toHaveBeenCalledWith(1);
      expect(toast.success).toHaveBeenCalledWith('Renamed');
    });

    it('shows rename error toast without breaking save when rename fails', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockRejectedValue(new Error('Rename conflict'));

      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, true);
      });

      expect(toast.success).toHaveBeenCalledWith('Metadata updated');
      expect(toast.error).toHaveBeenCalledWith('Rename failed: Rename conflict');
    });
  });

  describe('renameMutation', () => {
    it('toasts success on rename', async () => {
      (api.renameBook as Mock).mockResolvedValue({ message: 'Moved to new path' });

      const { result } = renderHook(() => useBookActions(5), { wrapper: createTestHarness().wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Moved to new path');
      });
    });

    it('shows error toast on rename failure', async () => {
      (api.renameBook as Mock).mockRejectedValue(new Error('Permission denied'));

      const { result } = renderHook(() => useBookActions(5), { wrapper: createTestHarness().wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Rename failed: Permission denied');
      });
    });
  });

  describe('cache invalidation', () => {
    it('invalidates book, bookFiles, and books queries after successful save', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(42), { wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 42] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 42, 'files'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
    });

    it('invalidates queries twice when save + rename both succeed', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockResolvedValue({ message: 'Done', filesRenamed: 1 });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(42), { wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, true);
      });

      // 3 calls from save + 3 calls from rename = 6
      const bookCalls = invalidateSpy.mock.calls.filter(
        ([arg]) => JSON.stringify(arg) === JSON.stringify({ queryKey: ['books', 42] })
      );
      expect(bookCalls).toHaveLength(2);
    });

    it('invalidates queries after successful standalone rename', async () => {
      (api.renameBook as Mock).mockResolvedValue({ message: 'Moved' });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(7), { wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 7] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 7, 'files'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
    });


    it('does not invalidate queries when save fails', async () => {
      (api.updateBook as Mock).mockRejectedValue(new Error('fail'));
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('does not invalidate queries when standalone rename fails', async () => {
      (api.renameBook as Mock).mockRejectedValue(new Error('fail'));
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(1), { wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  describe('mergeMutation', () => {
    it('calls api.mergeBookToM4b with the bookId', async () => {
      (api.mergeBookToM4b as Mock).mockResolvedValue({ status: 'started', bookId: 3 });
      const { result } = renderHook(() => useBookActions(3), { wrapper: createTestHarness().wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(api.mergeBookToM4b).toHaveBeenCalledWith(3));
    });

    it('shows info toast when merge is queued with position', async () => {
      (api.mergeBookToM4b as Mock).mockResolvedValue({ status: 'queued', bookId: 3, position: 2 });
      const { result } = renderHook(() => useBookActions(3), { wrapper: createTestHarness().wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Merge queued (position 2)'));
    });

    it('does not show success or info toast when merge starts immediately', async () => {
      (api.mergeBookToM4b as Mock).mockResolvedValue({ status: 'started', bookId: 3 });
      const { result } = renderHook(() => useBookActions(3), { wrapper: createTestHarness().wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(api.mergeBookToM4b).toHaveBeenCalled());
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('does not invalidate book queries on success (SSE-driven)', async () => {
      (api.mergeBookToM4b as Mock).mockResolvedValue({ status: 'started', bookId: 3 });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useBookActions(3), { wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(api.mergeBookToM4b).toHaveBeenCalled());
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('shows error toast on API-level merge failure (pre-SSE errors like 409)', async () => {
      (api.mergeBookToM4b as Mock).mockRejectedValue(new Error('Merge already in progress'));
      const { result } = renderHook(() => useBookActions(3), { wrapper: createTestHarness().wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Merge failed: Merge already in progress'));
    });

    it('does not handle enrichmentWarning in onSuccess (moved to SSE handler)', async () => {
      (api.mergeBookToM4b as Mock).mockResolvedValue({ status: 'started', bookId: 3 });
      const { result } = renderHook(() => useBookActions(3), { wrapper: createTestHarness().wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(api.mergeBookToM4b).toHaveBeenCalled());
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('does not invalidate queries when merge fails', async () => {
      (api.mergeBookToM4b as Mock).mockRejectedValue(new Error('fail'));
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useBookActions(3), { wrapper });

      act(() => { result.current.mergeMutation.mutate(); });

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  describe('ffmpegConfigured', () => {
    it('returns true when ffmpegPath is set', async () => {
      const { result } = renderHook(() => useBookActions(1), { wrapper: createTestHarness().wrapper });

      await waitFor(() => {
        expect(result.current.ffmpegConfigured).toBe(true);
      });
    });
  });

  describe('deleteMutation', () => {
    it('calls deleteBook API with correct book ID and deleteFiles=false', async () => {
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.deleteMutation.mutate({ deleteFiles: false });
      });

      await waitFor(() => {
        expect(api.deleteBook).toHaveBeenCalledWith(1, undefined);
      });
    });

    it('calls deleteBook API with correct book ID and deleteFiles=true', async () => {
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.deleteMutation.mutate({ deleteFiles: true });
      });

      await waitFor(() => {
        expect(api.deleteBook).toHaveBeenCalledWith(1, { deleteFiles: true });
      });
    });

    it('shows success toast on successful delete without files', async () => {
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.deleteMutation.mutate({ deleteFiles: false });
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Removed book from library');
      });
    });

    it('shows success toast mentioning files when deleteFiles=true', async () => {
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.deleteMutation.mutate({ deleteFiles: true });
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Removed book and deleted files from disk');
      });
    });

    it('invalidates books query cache on successful delete', async () => {
      (api.deleteBook as Mock).mockResolvedValue({ success: true });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.deleteMutation.mutate({ deleteFiles: false });
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
    });

    it('shows error toast on delete failure', async () => {
      (api.deleteBook as Mock).mockRejectedValue(new Error('Permission denied'));
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.deleteMutation.mutate({ deleteFiles: false });
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to remove book: Permission denied');
      });
    });
  });

  describe('wrongReleaseMutation', () => {
    it('calls api.markBookAsWrongRelease with correct book ID', async () => {
      (api.markBookAsWrongRelease as Mock).mockResolvedValue({ success: true });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.wrongReleaseMutation.mutate();
      });

      await waitFor(() => {
        expect(api.markBookAsWrongRelease).toHaveBeenCalledWith(1);
      });
    });

    it('shows success toast on successful wrong release', async () => {
      (api.markBookAsWrongRelease as Mock).mockResolvedValue({ success: true });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.wrongReleaseMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('wrong release'));
      });
    });

    it('shows error toast on wrong release failure', async () => {
      (api.markBookAsWrongRelease as Mock).mockRejectedValue(new Error('not imported'));
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      await act(async () => {
        result.current.wrongReleaseMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Wrong release failed: not imported');
      });
    });

    it('invalidates book, bookFiles, and books queries on success', async () => {
      (api.markBookAsWrongRelease as Mock).mockResolvedValue({ success: true });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useBookActions(5), { wrapper });

      act(() => { result.current.wrongReleaseMutation.mutate(); });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 5] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 5, 'files'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
    });
  });

  // #445 — uploadCoverMutation
  describe('uploadCoverMutation', () => {
    const testFile = new File(['data'], 'cover.jpg', { type: 'image/jpeg' });

    it('calls api.uploadBookCover with bookId and file', async () => {
      (api.uploadBookCover as Mock).mockResolvedValue({ id: 5, coverUrl: '/api/books/5/cover' });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(5), { wrapper });

      act(() => { result.current.uploadCoverMutation.mutate(testFile); });

      await waitFor(() => {
        expect(api.uploadBookCover).toHaveBeenCalledWith(5, testFile);
      });
    });

    it('shows success toast "Cover updated" on success', async () => {
      (api.uploadBookCover as Mock).mockResolvedValue({ id: 5, coverUrl: '/api/books/5/cover' });
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(5), { wrapper });

      act(() => { result.current.uploadCoverMutation.mutate(testFile); });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Cover updated');
      });
    });

    it('invalidates book, bookFiles, and books queries on success', async () => {
      (api.uploadBookCover as Mock).mockResolvedValue({ id: 5, coverUrl: '/api/books/5/cover' });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useBookActions(5), { wrapper });

      act(() => { result.current.uploadCoverMutation.mutate(testFile); });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 5] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 5, 'files'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
    });

    it('shows error toast on upload failure', async () => {
      (api.uploadBookCover as Mock).mockRejectedValue(new Error('Server error'));
      const { wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(5), { wrapper });

      act(() => { result.current.uploadCoverMutation.mutate(testFile); });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Cover upload failed: Server error');
      });
    });
  });

  describe('refreshScanMutation', () => {
    it('calls api.refreshScanBook with correct bookId', async () => {
      (api.refreshScanBook as Mock).mockResolvedValue({
        bookId: 42, codec: 'mp3', bitrate: 128000, fileCount: 3, durationMinutes: 120, narratorsUpdated: true,
      });
      const { queryClient, wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(42), { wrapper });

      act(() => { result.current.refreshScanMutation.mutate(); });

      await waitFor(() => {
        expect(api.refreshScanBook).toHaveBeenCalledWith(42);
      });
      queryClient.clear();
    });

    it('shows success toast "Refreshed audio metadata" on success', async () => {
      (api.refreshScanBook as Mock).mockResolvedValue({
        bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
      });
      const { queryClient, wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      act(() => { result.current.refreshScanMutation.mutate(); });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Refreshed audio metadata');
      });
      queryClient.clear();
    });

    it('shows error toast on API failure', async () => {
      (api.refreshScanBook as Mock).mockRejectedValue(new Error('No audio files found'));
      const { queryClient, wrapper } = createTestHarness();
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      act(() => { result.current.refreshScanMutation.mutate(); });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Refresh scan failed: No audio files found');
      });
      queryClient.clear();
    });

    it('invalidates book, bookFiles, and books query keys after successful scan', async () => {
      (api.refreshScanBook as Mock).mockResolvedValue({
        bookId: 1, codec: 'mp3', bitrate: 128000, fileCount: 1, durationMinutes: 60, narratorsUpdated: false,
      });
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useBookActions(1), { wrapper });

      act(() => { result.current.refreshScanMutation.mutate(); });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 1] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 1, 'files'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
      queryClient.clear();
    });
  });
});
