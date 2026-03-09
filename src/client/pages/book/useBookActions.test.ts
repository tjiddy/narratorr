import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useBookActions } from './useBookActions.js';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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
      getSettings: vi.fn().mockResolvedValue({
        processing: { ffmpegPath: '/usr/bin/ffmpeg', enabled: false, outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only' },
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
        search: { intervalMinutes: 360, enabled: true },
        import: { deleteAfterImport: false, minSeedTime: 60 },
        general: { logLevel: 'info' },
        metadata: { audibleRegion: 'us' },
        tagging: { enabled: false, mode: 'populate_missing', embedCover: false },
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
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

      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'New Title' }, false, onSuccess);
      });

      expect(onSuccess).toHaveBeenCalledOnce();
      expect(toast.success).toHaveBeenCalledWith('Metadata updated');
    });

    it('does not call onSuccess when metadata update fails', async () => {
      (api.updateBook as Mock).mockRejectedValue(new Error('Network error'));
      const onSuccess = vi.fn();

      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'New Title' }, false, onSuccess);
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Failed to update book: Network error');
    });

    it('shows error toast when metadata update rejects with non-Error', async () => {
      (api.updateBook as Mock).mockRejectedValue('string error');

      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to update book: Unknown error');
    });

    it('resets isSaving after failure', async () => {
      (api.updateBook as Mock).mockRejectedValue(new Error('fail'));

      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

      expect(result.current.isSaving).toBe(false);

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(result.current.isSaving).toBe(false);
    });

    it('attempts rename after successful save when renameFiles is true', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockResolvedValue({ message: 'Renamed', filesRenamed: 1 });

      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, true);
      });

      expect(api.renameBook).toHaveBeenCalledWith(1);
      expect(toast.success).toHaveBeenCalledWith('Renamed');
    });

    it('shows rename error toast without breaking save when rename fails', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      (api.renameBook as Mock).mockRejectedValue(new Error('Rename conflict'));

      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

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

      const { result } = renderHook(() => useBookActions(5, false), { wrapper: createTestHarness().wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Moved to new path');
      });
    });

    it('shows error toast on rename failure', async () => {
      (api.renameBook as Mock).mockRejectedValue(new Error('Permission denied'));

      const { result } = renderHook(() => useBookActions(5, false), { wrapper: createTestHarness().wrapper });

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

      const { result } = renderHook(() => useBookActions(42, false), { wrapper });

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

      const { result } = renderHook(() => useBookActions(42, false), { wrapper });

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

      const { result } = renderHook(() => useBookActions(7, false), { wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 7] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 7, 'files'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
    });

    it('invalidates queries after successful monitor toggle', async () => {
      (api.updateBook as Mock).mockResolvedValue({});
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(3, true), { wrapper });

      act(() => {
        result.current.monitorMutation.mutate();
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 3] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 3, 'files'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      });
    });

    it('does not invalidate queries when save fails', async () => {
      (api.updateBook as Mock).mockRejectedValue(new Error('fail'));
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(1, false), { wrapper });

      await act(async () => {
        await result.current.handleSave({ title: 'x' }, false);
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('does not invalidate queries when standalone rename fails', async () => {
      (api.renameBook as Mock).mockRejectedValue(new Error('fail'));
      const { queryClient, wrapper } = createTestHarness();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(() => useBookActions(1, false), { wrapper });

      act(() => {
        result.current.renameMutation.mutate();
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  describe('ffmpegConfigured', () => {
    it('returns true when ffmpegPath is set', async () => {
      const { result } = renderHook(() => useBookActions(1, false), { wrapper: createTestHarness().wrapper });

      await waitFor(() => {
        expect(result.current.ffmpegConfigured).toBe(true);
      });
    });
  });
});
