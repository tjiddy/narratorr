import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConnectionTest } from '@/hooks/useConnectionTest';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from 'sonner';

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useConnectionTest', () => {
  const testById = vi.fn();
  const testByConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderTestHook() {
    return renderHook(() =>
      useConnectionTest<{ name: string }>({ testById, testByConfig }),
    { wrapper: createWrapper() });
  }

  describe('handleTest (by ID)', () => {
    it('sets testingId during test and clears it after', async () => {
      let resolvePromise: (v: { success: boolean }) => void;
      testById.mockReturnValue(new Promise((r) => { resolvePromise = r; }));

      const { result } = renderTestHook();

      expect(result.current.testingId).toBeNull();

      let testPromise: Promise<void>;
      act(() => {
        testPromise = result.current.handleTest(42);
      });

      expect(result.current.testingId).toBe(42);

      await act(async () => {
        resolvePromise!({ success: true });
        await testPromise!;
      });

      expect(result.current.testingId).toBeNull();
    });

    it('stores success result and shows toast', async () => {
      testById.mockResolvedValue({ success: true });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleTest(1);
      });

      expect(result.current.testResult).toEqual({ id: 1, success: true });
      expect(toast.success).toHaveBeenCalledWith('Connection successful');
    });

    it('stores failure result and shows toast', async () => {
      testById.mockResolvedValue({ success: false, message: 'Refused' });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleTest(2);
      });

      expect(result.current.testResult).toEqual({ id: 2, success: false, message: 'Refused' });
      expect(toast.error).toHaveBeenCalledWith('Refused');
    });

    it('handles thrown errors', async () => {
      testById.mockRejectedValue(new Error('Network'));

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleTest(3);
      });

      expect(result.current.testResult).toEqual({ id: 3, success: false, message: 'Test failed' });
      expect(toast.error).toHaveBeenCalledWith('Connection test failed');
    });
  });

  describe('handleTest flicker prevention (by ID)', () => {
    it('preserves previous testResult while re-test is in flight (no null flash)', async () => {
      testById.mockResolvedValueOnce({ success: false, message: 'Refused' });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleTest(1);
      });

      expect(result.current.testResult).toEqual({ id: 1, success: false, message: 'Refused' });

      // Second test starts — previous result should remain visible during flight
      let resolveSecond: (v: { success: boolean }) => void;
      testById.mockReturnValue(new Promise((r) => { resolveSecond = r; }));

      let testPromise: Promise<void>;
      act(() => {
        testPromise = result.current.handleTest(1);
      });

      // While in-flight, testResult should still be the PREVIOUS result, not null
      expect(result.current.testResult).toEqual({ id: 1, success: false, message: 'Refused' });

      await act(async () => {
        resolveSecond!({ success: true });
        await testPromise!;
      });

      expect(result.current.testResult).toEqual({ id: 1, success: true });
    });
  });

  describe('handleFormTest (by config)', () => {
    it('sets testingForm during test and clears it after', async () => {
      let resolvePromise: (v: { success: boolean }) => void;
      testByConfig.mockReturnValue(new Promise((r) => { resolvePromise = r; }));

      const { result } = renderTestHook();

      expect(result.current.testingForm).toBe(false);

      let testPromise: Promise<void>;
      act(() => {
        testPromise = result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.testingForm).toBe(true);

      await act(async () => {
        resolvePromise!({ success: true });
        await testPromise!;
      });

      expect(result.current.testingForm).toBe(false);
    });

    it('stores success result', async () => {
      testByConfig.mockResolvedValue({ success: true });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({ success: true });
      expect(toast.success).toHaveBeenCalledWith('Connection successful');
    });

    it('stores failure result', async () => {
      testByConfig.mockResolvedValue({ success: false, message: 'Bad config' });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({ success: false, message: 'Bad config' });
      expect(toast.error).toHaveBeenCalledWith('Bad config');
    });

    it('handles thrown errors', async () => {
      testByConfig.mockRejectedValue(new Error('Network'));

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({ success: false, message: 'Test failed' });
    });
  });

  describe('handleFormTest flicker prevention', () => {
    it('preserves previous formTestResult while re-test is in flight (no null flash)', async () => {
      // First test fails
      testByConfig.mockResolvedValueOnce({ success: false, message: 'Bad config' });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({ success: false, message: 'Bad config' });

      // Second test starts — previous result should remain visible during flight
      let resolveSecond: (v: { success: boolean }) => void;
      testByConfig.mockReturnValue(new Promise((r) => { resolveSecond = r; }));

      let testPromise: Promise<void>;
      act(() => {
        testPromise = result.current.handleFormTest({ name: 'corrected' });
      });

      // While in-flight, formTestResult should still be the PREVIOUS result, not null
      expect(result.current.formTestResult).toEqual({ success: false, message: 'Bad config' });

      await act(async () => {
        resolveSecond!({ success: true });
        await testPromise!;
      });

      expect(result.current.formTestResult).toEqual({ success: true });
    });

    it('replaces previous result with new result when re-test completes', async () => {
      testByConfig.mockResolvedValueOnce({ success: false, message: 'First error' });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({ success: false, message: 'First error' });

      testByConfig.mockResolvedValueOnce({ success: true });

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({ success: true });
    });
  });

  describe('clearFormTestResult', () => {
    it('clears formTestResult', async () => {
      testByConfig.mockResolvedValue({ success: true });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).not.toBeNull();

      act(() => {
        result.current.clearFormTestResult();
      });

      expect(result.current.formTestResult).toBeNull();
    });
  });

  describe('#317 — invalidateOnSuccess', () => {
    it('invalidates queries on successful test-by-ID when invalidateOnSuccess is set', async () => {
      testById.mockResolvedValue({ success: true, metadata: { isVip: true } });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);

      const wrapper = function Wrapper({ children }: { children: ReactNode }) {
        return createElement(QueryClientProvider, { client: queryClient }, children);
      };

      const { result } = renderHook(() =>
        useConnectionTest<{ name: string }>({
          testById,
          testByConfig,
          invalidateOnSuccess: ['indexers'],
        }),
      { wrapper });

      await act(async () => {
        await result.current.handleTest(5);
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['indexers'] });
    });

    it('does not invalidate queries on failed test-by-ID', async () => {
      testById.mockResolvedValue({ success: false, message: 'Auth failed' });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = function Wrapper({ children }: { children: ReactNode }) {
        return createElement(QueryClientProvider, { client: queryClient }, children);
      };

      const { result } = renderHook(() =>
        useConnectionTest<{ name: string }>({
          testById,
          testByConfig,
          invalidateOnSuccess: ['indexers'],
        }),
      { wrapper });

      await act(async () => {
        await result.current.handleTest(5);
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  describe('#317 — metadata pass-through in result state', () => {
    it('testResult retains metadata from handleTest (by ID)', async () => {
      const metadata = { isVip: true, username: 'VipUser', classname: 'VIP' };
      testById.mockResolvedValue({ success: true, message: 'Connected', metadata });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleTest(7);
      });

      expect(result.current.testResult).toEqual({
        id: 7,
        success: true,
        message: 'Connected',
        metadata: { isVip: true, username: 'VipUser', classname: 'VIP' },
      });
    });

    it('formTestResult retains metadata from handleFormTest (by config)', async () => {
      const metadata = { isVip: false, username: 'RegularUser', classname: 'User' };
      testByConfig.mockResolvedValue({ success: true, message: 'OK', metadata });

      const { result } = renderTestHook();

      await act(async () => {
        await result.current.handleFormTest({ name: 'test' });
      });

      expect(result.current.formTestResult).toEqual({
        success: true,
        message: 'OK',
        metadata: { isVip: false, username: 'RegularUser', classname: 'User' },
      });
    });
  });
});
