import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAnalyseAttributionAction } from './useAnalyseAttributionAction.js';

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
      analyseBookAttribution: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        earwitness: { enabled: true, baseUrl: 'http://earwitness:8080', apiKey: 'k' },
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

describe('useAnalyseAttributionAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.analyseBookAttribution with the book ID', async () => {
    (api.analyseBookAttribution as Mock).mockResolvedValue({ bookId: 3, outcome: 'ok', eventId: 9 });
    const { wrapper } = createTestHarness();
    const { result } = renderHook(() => useAnalyseAttributionAction(3), { wrapper });

    act(() => { result.current.analyseAttributionMutation.mutate(); });

    await waitFor(() => {
      expect(api.analyseBookAttribution).toHaveBeenCalledWith(3);
    });
  });

  it('invalidates the event-history queries on success', async () => {
    (api.analyseBookAttribution as Mock).mockResolvedValue({ bookId: 3, outcome: 'ok', eventId: 9 });
    const { queryClient, wrapper } = createTestHarness();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAnalyseAttributionAction(3), { wrapper });

    act(() => { result.current.analyseAttributionMutation.mutate(); });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory', 'book', 3] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory'] });
    });
  });

  it('shows an error toast and does not crash on failure', async () => {
    (api.analyseBookAttribution as Mock).mockRejectedValue(new Error('earwitness down'));
    const { wrapper } = createTestHarness();
    const { result } = renderHook(() => useAnalyseAttributionAction(3), { wrapper });

    act(() => { result.current.analyseAttributionMutation.mutate(); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Earwitness analysis failed: earwitness down');
    });
  });

  it('exposes earwitnessEnabled from settings', async () => {
    const { wrapper } = createTestHarness();
    const { result } = renderHook(() => useAnalyseAttributionAction(3), { wrapper });

    await waitFor(() => {
      expect(result.current.earwitnessEnabled).toBe(true);
    });
  });

  it('reports earwitnessEnabled false when the integration is disabled', async () => {
    (api.getSettings as Mock).mockResolvedValue({ earwitness: { enabled: false, baseUrl: '', apiKey: '' } });
    const { wrapper } = createTestHarness();
    const { result } = renderHook(() => useAnalyseAttributionAction(3), { wrapper });

    await waitFor(() => {
      expect(result.current.earwitnessEnabled).toBe(false);
    });
  });
});
