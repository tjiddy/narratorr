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
        expect(result.current.state.isLoading).toBe(false);
      });

      expect(result.current.state.items).toEqual(items);
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
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(true);

      await act(async () => {
        result.current.mutations.createMutation.mutate({ name: 'New Indexer', url: 'https://example.com' });
      });

      expect(createFn).toHaveBeenCalledWith({ name: 'New Indexer', url: 'https://example.com' }, expect.anything());
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
      expect(toast.success).toHaveBeenCalledWith('Indexer added successfully');
      // Form closes on success
      expect(result.current.state.showForm).toBe(false);
    });

    it('shows error toast on create failure', async () => {
      createFn.mockRejectedValue(new Error('Server error'));

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.mutations.createMutation.mutate({ name: 'Bad', url: 'https://example.com' });
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
        result.current.actions.handleEdit(1);
      });

      expect(result.current.state.editingId).toBe(1);

      await act(async () => {
        result.current.mutations.updateMutation.mutate({ id: 1, data: { name: 'Updated', url: 'https://example.com' } });
      });

      expect(updateFn).toHaveBeenCalledWith(1, { name: 'Updated', url: 'https://example.com' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
      expect(toast.success).toHaveBeenCalledWith('Indexer updated');
      // Editing clears on success
      expect(result.current.state.editingId).toBeNull();
    });

    it('shows error toast on update failure', async () => {
      updateFn.mockRejectedValue(new Error('Server error'));

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.mutations.updateMutation.mutate({ id: 1, data: { name: 'Bad', url: 'https://example.com' } });
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
        result.current.mutations.deleteMutation.mutate(1);
      });

      expect(deleteFn).toHaveBeenCalledWith(1, expect.anything());
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
      expect(toast.success).toHaveBeenCalledWith('Indexer removed successfully');
    });

    it('shows error toast on delete failure', async () => {
      deleteFn.mockRejectedValue(new Error('Server error'));

      const { result } = renderCrudHook();

      await act(async () => {
        result.current.mutations.deleteMutation.mutate(1);
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to delete indexer');
    });
  });

  describe('form state coordination', () => {
    it('handleToggleForm opens form and clears editingId', () => {
      const { result } = renderCrudHook();

      // Start editing first
      act(() => {
        result.current.actions.handleEdit(1);
      });

      expect(result.current.state.editingId).toBe(1);

      // Toggle form open — should clear editingId
      act(() => {
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(true);
      expect(result.current.state.editingId).toBeNull();
    });

    it('handleToggleForm closing form clears formTestResult', () => {
      const { result } = renderCrudHook();

      // Open form
      act(() => {
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(true);

      // Close form — should clear formTestResult
      act(() => {
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(false);
      expect(mockClearFormTestResult).toHaveBeenCalled();
    });

    it('handleEdit closes form and clears formTestResult', () => {
      const { result } = renderCrudHook();

      // Open form first
      act(() => {
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(true);

      // Start editing — should close form and clear formTestResult
      act(() => {
        result.current.actions.handleEdit(5);
      });

      expect(result.current.state.showForm).toBe(false);
      expect(result.current.state.editingId).toBe(5);
      expect(mockClearFormTestResult).toHaveBeenCalled();
    });

    it('handleCancelEdit clears editingId and formTestResult', () => {
      const { result } = renderCrudHook();

      act(() => {
        result.current.actions.handleEdit(3);
      });

      expect(result.current.state.editingId).toBe(3);

      act(() => {
        result.current.actions.handleCancelEdit();
      });

      expect(result.current.state.editingId).toBeNull();
      expect(mockClearFormTestResult).toHaveBeenCalled();
    });
  });
});

describe('grouped return shape (REACT-1 refactor)', () => {
  const queryKey = ['test-entities'] as const;
  const queryFn = vi.fn<() => Promise<TestItem[]>>();
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    queryFn.mockResolvedValue([]);
    vi.mocked(useConnectionTest).mockReturnValue({
      testingId: null, testResult: null, testingForm: false, formTestResult: null,
      handleTest: vi.fn(), handleFormTest: vi.fn(), clearFormTestResult: vi.fn(),
    });
  });

  function renderGroupedHook() {
    return renderHook(
      () => useCrudSettings<TestItem, TestFormData>({
        queryKey, queryFn,
        createFn: vi.fn(), updateFn: vi.fn(), deleteFn: vi.fn(),
        testById: vi.fn(), testByConfig: vi.fn(), entityName: 'Indexer',
      }),
      { wrapper: createWrapper(queryClient) },
    );
  }

  it('returned object has state, actions, mutations, tests keys with no top-level leaked values', () => {
    const { result } = renderGroupedHook();
    expect(result.current).toHaveProperty('state');
    expect(result.current).toHaveProperty('actions');
    expect(result.current).toHaveProperty('mutations');
    expect(result.current).toHaveProperty('tests');
    expect(result.current).not.toHaveProperty('items');
    expect(result.current).not.toHaveProperty('isLoading');
    expect(result.current).not.toHaveProperty('showForm');
    expect(result.current).not.toHaveProperty('createMutation');
    expect(result.current).not.toHaveProperty('testingId');
  });

  it('state group contains items, isLoading, showForm, editingId, deleteTarget', () => {
    const { result } = renderGroupedHook();
    expect(result.current.state).toMatchObject({
      items: [],
      showForm: false,
      editingId: null,
      deleteTarget: null,
    });
    expect(result.current.state).toHaveProperty('isLoading');
  });

  it('actions group contains setDeleteTarget, handleToggleForm, handleEdit, handleCancelEdit', () => {
    const { result } = renderGroupedHook();
    const actionNames = ['setDeleteTarget', 'handleToggleForm', 'handleEdit', 'handleCancelEdit'] as const;
    for (const name of actionNames) {
      expect(typeof result.current.actions[name]).toBe('function');
    }
  });

  it('mutations group contains createMutation, updateMutation, deleteMutation', () => {
    const { result } = renderGroupedHook();
    expect(result.current.mutations).toHaveProperty('createMutation');
    expect(result.current.mutations).toHaveProperty('updateMutation');
    expect(result.current.mutations).toHaveProperty('deleteMutation');
  });

  it('tests group contains all connectionTest values', () => {
    const { result } = renderGroupedHook();
    expect(result.current.tests).toMatchObject({
      testingId: null,
      testResult: null,
      testingForm: false,
      formTestResult: null,
    });
    expect(typeof result.current.tests.handleTest).toBe('function');
    expect(typeof result.current.tests.handleFormTest).toBe('function');
    expect(typeof result.current.tests.clearFormTestResult).toBe('function');
  });
});
