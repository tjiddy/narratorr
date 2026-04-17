import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRetryImportAvailable } from './useRetryImportAvailable';
import { api } from '@/lib/api';
import React from 'react';

vi.mock('@/lib/api', () => ({
  api: {
    checkRetryImportAvailable: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useRetryImportAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when book is failed and API reports available', async () => {
    vi.mocked(api.checkRetryImportAvailable).mockResolvedValue({ available: true });

    const { result } = renderHook(() => useRetryImportAvailable(1, 'failed'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(api.checkRetryImportAvailable).toHaveBeenCalledWith(1);
  });

  it('returns false when book is failed but API reports not available', async () => {
    vi.mocked(api.checkRetryImportAvailable).mockResolvedValue({ available: false });

    const { result } = renderHook(() => useRetryImportAvailable(2, 'failed'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(api.checkRetryImportAvailable).toHaveBeenCalledWith(2);
    });
    expect(result.current).toBe(false);
  });

  it('returns false and does not query when status is not failed', () => {
    const { result } = renderHook(() => useRetryImportAvailable(3, 'imported'), { wrapper: createWrapper() });

    expect(result.current).toBe(false);
    expect(api.checkRetryImportAvailable).not.toHaveBeenCalled();
  });
});
