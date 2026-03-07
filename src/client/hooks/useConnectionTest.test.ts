import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConnectionTest } from '@/hooks/useConnectionTest';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from 'sonner';

describe('useConnectionTest', () => {
  const testById = vi.fn();
  const testByConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderTestHook() {
    return renderHook(() =>
      useConnectionTest<{ name: string }>({ testById, testByConfig }),
    );
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
});
