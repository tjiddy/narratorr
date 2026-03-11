import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useCrudSettings } from './useCrudSettings';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/useConnectionTest', () => ({
  useConnectionTest: vi.fn(() => ({
    testingId: null,
    testResult: null,
    testingForm: false,
    formTestResult: null,
    handleTest: vi.fn(),
    handleFormTest: vi.fn(),
    clearFormTestResult: vi.fn(),
  })),
}));

import { toast } from 'sonner';
import { useConnectionTest } from '@/hooks/useConnectionTest';

interface TestItem {
  id: number;
  name: string;
}

interface TestFormData {
  name: string;
  url: string;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useCrudSettings', () => {
  const queryKey = ['test-entities'] as const;
  const queryFn = vi.fn<() => Promise<TestItem[]>>();
  const createFn = vi.fn<(data: TestFormData) => Promise<TestItem>>();
  const updateFn = vi.fn<(id: number, data: TestFormData) => Promise<TestItem>>();
  const deleteFn = vi.fn<(id: number) => Promise<unknown>>();
  const testById = vi.fn();
  const testByConfig = vi.fn();
  const entityName = 'Indexer';

  let mockClearFormTestResult: ReturnType<typeof vi.fn<() => void>>;
  let queryClient: QueryClient;

  function renderCrudHook() {
    return renderHook(
      () =>
        useCrudSettings<TestItem, TestFormData>({
          queryKey,
          queryFn,
          createFn,
          updateFn,
          deleteFn,
          testById,
          testByConfig,
          entityName,
        }),
      { wrapper: createWrapper(queryClient) },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    queryFn.mockResolvedValue([]);
    mockClearFormTestResult = vi.fn();
    vi.mocked(useConnectionTest).mockReturnValue({
      testingId: null,
      testResult: null,
      testingForm: false,
      formTestResult: null,
      handleTest: vi.fn(),
      handleFormTest: vi.fn(),
      clearFormTestResult: mockClearFormTestResult,
    });
  });

  describe('query', () => {
    it('loads items from queryFn', async () => {
      const items: TestItem[] = [{ id: 1, name: 'NZBgeek' }];
      queryFn.mockResolvedValue(items);

      const { result } = renderCrudHook();

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toEqual(items);
    });
  });

  describe('createMutation', () => {
    it('invalidates queries and shows success toast on create', async () => {
      const newItem: TestItem = { id: 2, name: 'New Indexer' };
      createFn.mockResolvedValue(newItem);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderCrudHook();

      // Open form first
      act(() => {
        result.current.handleToggleForm();
      });

      expect(result.current.showForm).toBe(true);

      await act(async () => {
        result.current.createMutation.mutate({ name: 'New Indexer', url: 'https://example.com' });
      });

      expect(createFn).toHaveBeenCalledWith({ name: 'New Indexer', url: 'https://example.com' }, expect.anything());
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
      expect(toast.success).toHaveBeenCalledWith('Indexer added successfully');
      // Form closes on success
      expect(result.current.showForm).toBe(false);
    });

    it('shows error toast on create failure', async () => {
      createFn.mockRejectedValue(new Error('Server error'));

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.createMutation.mutate({ name: 'Bad', url: 'https://example.com' });
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to add indexer');
    });
  });

  describe('updateMutation', () => {
    it('invalidates queries and shows success toast on update', async () => {
      const updated: TestItem = { id: 1, name: 'Updated' };
      updateFn.mockResolvedValue(updated);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderCrudHook();

      // Start editing
      act(() => {
        result.current.handleEdit(1);
      });

      expect(result.current.editingId).toBe(1);

      await act(async () => {
        result.current.updateMutation.mutate({ id: 1, data: { name: 'Updated', url: 'https://example.com' } });
      });

      expect(updateFn).toHaveBeenCalledWith(1, { name: 'Updated', url: 'https://example.com' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
      expect(toast.success).toHaveBeenCalledWith('Indexer updated');
      // Editing clears on success
      expect(result.current.editingId).toBeNull();
    });

    it('shows error toast on update failure', async () => {
      updateFn.mockRejectedValue(new Error('Server error'));

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.updateMutation.mutate({ id: 1, data: { name: 'Bad', url: 'https://example.com' } });
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to update indexer');
    });
  });

  describe('deleteMutation', () => {
    it('invalidates queries and shows success toast on delete', async () => {
      deleteFn.mockResolvedValue({});
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.deleteMutation.mutate(1);
      });

      expect(deleteFn).toHaveBeenCalledWith(1, expect.anything());
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
      expect(toast.success).toHaveBeenCalledWith('Indexer removed successfully');
    });

    it('shows error toast on delete failure', async () => {
      deleteFn.mockRejectedValue(new Error('Server error'));

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.deleteMutation.mutate(1);
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to delete indexer');
    });
  });

  describe('form state coordination', () => {
    it('handleToggleForm opens form and clears editingId', () => {
      const { result } = renderCrudHook();

      // Start editing first
      act(() => {
        result.current.handleEdit(1);
      });

      expect(result.current.editingId).toBe(1);

      // Toggle form open — should clear editingId
      act(() => {
        result.current.handleToggleForm();
      });

      expect(result.current.showForm).toBe(true);
      expect(result.current.editingId).toBeNull();
    });

    it('handleToggleForm closing form clears formTestResult', () => {
      const { result } = renderCrudHook();

      // Open form
      act(() => {
        result.current.handleToggleForm();
      });

      expect(result.current.showForm).toBe(true);

      // Close form — should clear formTestResult
      act(() => {
        result.current.handleToggleForm();
      });

      expect(result.current.showForm).toBe(false);
      expect(mockClearFormTestResult).toHaveBeenCalled();
    });

    it('handleEdit closes form and clears formTestResult', () => {
      const { result } = renderCrudHook();

      // Open form first
      act(() => {
        result.current.handleToggleForm();
      });

      expect(result.current.showForm).toBe(true);

      // Start editing — should close form and clear formTestResult
      act(() => {
        result.current.handleEdit(5);
      });

      expect(result.current.showForm).toBe(false);
      expect(result.current.editingId).toBe(5);
      expect(mockClearFormTestResult).toHaveBeenCalled();
    });

    it('handleCancelEdit clears editingId and formTestResult', () => {
      const { result } = renderCrudHook();

      act(() => {
        result.current.handleEdit(3);
      });

      expect(result.current.editingId).toBe(3);

      act(() => {
        result.current.handleCancelEdit();
      });

      expect(result.current.editingId).toBeNull();
      expect(mockClearFormTestResult).toHaveBeenCalled();
    });
  });
});
