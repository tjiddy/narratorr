import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useMutationWithToast } from './useMutationWithToast.js';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from 'sonner';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useMutationWithToast', () => {
  const queryKey = ['test-key'] as const;
  const mutationFn = vi.fn<() => Promise<string>>();
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
  });

  it('calls toast.success(successMessage) on mutation success', async () => {
    mutationFn.mockResolvedValue('ok');

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(toast.success).toHaveBeenCalledWith('Saved!');
  });

  it('calls queryClient.invalidateQueries with the provided queryKey on success', async () => {
    mutationFn.mockResolvedValue('ok');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
  });

  it('calls toast.error(errorMessage) when errorMessage is a static string', async () => {
    mutationFn.mockRejectedValue(new Error('server error'));

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Something went wrong',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(toast.error).toHaveBeenCalledWith('Something went wrong');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('calls toast.error(errorMessage(error)) when errorMessage is a function, passing the error', async () => {
    const serverError = new Error('server-provided message');
    mutationFn.mockRejectedValue(serverError);

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: (err) => (err instanceof Error ? err.message : 'Failed'),
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(toast.error).toHaveBeenCalledWith('server-provided message');
  });

  it('invokes optional onSuccess callback after toast and invalidation on success', async () => {
    mutationFn.mockResolvedValue('result-value');
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
          onSuccess,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(onSuccess).toHaveBeenCalledWith('result-value', undefined, undefined);
    expect(toast.success).toHaveBeenCalledWith('Saved!');
  });

  it('does not invoke onSuccess callback when mutation fails', async () => {
    mutationFn.mockRejectedValue(new Error('fail'));
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
          onSuccess,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('invokes optional onError callback after error toast on failure', async () => {
    const error = new Error('fail');
    mutationFn.mockRejectedValue(error);
    const onError = vi.fn();

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
          onError,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(onError).toHaveBeenCalledWith(error, undefined, undefined);
    expect(toast.error).toHaveBeenCalledWith('Failed');
  });

  it('does not invoke onError callback when mutation succeeds', async () => {
    mutationFn.mockResolvedValue('ok');
    const onError = vi.fn();

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
          onError,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(onError).not.toHaveBeenCalled();
  });

  it('invalidates all keys when queryKey is an array of keys', async () => {
    mutationFn.mockResolvedValue('ok');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const keyA = ['auth', 'config'] as const;
    const keyB = ['auth', 'status'] as const;

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey: [keyA, keyB],
          successMessage: 'Done',
          errorMessage: 'Failed',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: keyA });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: keyB });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('works correctly without onSuccess or onError callbacks provided', async () => {
    mutationFn.mockResolvedValue('ok');

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await act(async () => {
      result.current.mutate(undefined);
    });

    expect(toast.success).toHaveBeenCalledWith('Saved!');
  });

  it('exposes isPending, mutate, and other standard TanStack mutation fields', () => {
    mutationFn.mockResolvedValue('ok');

    const { result } = renderHook(
      () =>
        useMutationWithToast({
          mutationFn,
          queryKey,
          successMessage: 'Saved!',
          errorMessage: 'Failed',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    expect(typeof result.current.mutate).toBe('function');
    expect(typeof result.current.mutateAsync).toBe('function');
    expect(typeof result.current.isPending).toBe('boolean');
    expect(typeof result.current.isError).toBe('boolean');
    expect(typeof result.current.isSuccess).toBe('boolean');
  });
});
