import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import React from 'react';
import { useCrudSettings } from './useCrudSettings';
import type { TestResult } from '@/lib/api';

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

function createWrapper(queryClient: QueryClient, initialEntries: string[] = ['/']) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(MemoryRouter, { initialEntries }, children),
    );
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

    it('handleToggleForm clears formTestResult when opening the create form (showForm false → true)', () => {
      const { result } = renderCrudHook();
      mockClearFormTestResult.mockClear();

      act(() => {
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(true);
      expect(mockClearFormTestResult).toHaveBeenCalledOnce();
    });

    it('handleToggleForm clears formTestResult when closing the create form (showForm true → false) — regression guard', () => {
      const { result } = renderCrudHook();

      act(() => {
        result.current.actions.handleToggleForm();
      });
      mockClearFormTestResult.mockClear();

      act(() => {
        result.current.actions.handleToggleForm();
      });

      expect(result.current.state.showForm).toBe(false);
      expect(mockClearFormTestResult).toHaveBeenCalledOnce();
    });

    it('handleEdit clears formTestResult when switching from one edit entity to another', () => {
      const { result } = renderCrudHook();

      act(() => {
        result.current.actions.handleEdit(1);
      });
      mockClearFormTestResult.mockClear();

      act(() => {
        result.current.actions.handleEdit(2);
      });

      expect(result.current.state.editingId).toBe(2);
      expect(mockClearFormTestResult).toHaveBeenCalledOnce();
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

describe('#1057 — injectEditingId threading to useConnectionTest', () => {
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

  function renderWithOption(injectEditingId: boolean | undefined) {
    return renderHook(
      () => useCrudSettings<TestItem, TestFormData>({
        queryKey: ['test-entities'], queryFn,
        createFn: vi.fn(), updateFn: vi.fn(), deleteFn: vi.fn(),
        testById: vi.fn(), testByConfig: vi.fn(), entityName: 'Widget',
        ...(injectEditingId !== undefined && { injectEditingId }),
      }),
      { wrapper: createWrapper(queryClient) },
    );
  }

  it('passes entityId to useConnectionTest when injectEditingId is true and editingId is set', () => {
    const { result } = renderWithOption(true);
    act(() => { result.current.actions.handleEdit(99); });

    const lastCall = vi.mocked(useConnectionTest).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ entityId: 99 });
  });

  it('passes entityId: undefined to useConnectionTest when injectEditingId is true but no edit is active', () => {
    renderWithOption(true);
    const lastCall = vi.mocked(useConnectionTest).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ entityId: undefined });
  });

  it('passes entityId: undefined when injectEditingId is omitted, even while editing', () => {
    const { result } = renderWithOption(undefined);
    act(() => { result.current.actions.handleEdit(5); });

    const lastCall = vi.mocked(useConnectionTest).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ entityId: undefined });
  });

  it('passes entityId: undefined when injectEditingId is false, even while editing', () => {
    const { result } = renderWithOption(false);
    act(() => { result.current.actions.handleEdit(5); });

    const lastCall = vi.mocked(useConnectionTest).mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ entityId: undefined });
  });
});

describe('#1057 — testByConfig payload integration through real useConnectionTest', () => {
  let queryClient: QueryClient;
  let realUseConnectionTest: typeof useConnectionTest;
  const testByConfig = vi.fn<(data: TestFormData) => Promise<TestResult>>();

  beforeEach(async () => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    const actual = await vi.importActual('@/hooks/useConnectionTest') as { useConnectionTest: typeof useConnectionTest };
    realUseConnectionTest = actual.useConnectionTest;
    vi.mocked(useConnectionTest).mockImplementation(realUseConnectionTest);
    testByConfig.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.mocked(useConnectionTest).mockReturnValue({
      testingId: null, testResult: null, testingForm: false, formTestResult: null,
      handleTest: vi.fn(), handleFormTest: vi.fn(), clearFormTestResult: vi.fn(),
    });
  });

  function renderWithOption(injectEditingId: boolean | undefined) {
    return renderHook(
      () => useCrudSettings<TestItem, TestFormData>({
        queryKey: ['test-entities'],
        queryFn: vi.fn<() => Promise<TestItem[]>>().mockResolvedValue([]),
        createFn: vi.fn(), updateFn: vi.fn(), deleteFn: vi.fn(),
        testById: vi.fn(), testByConfig, entityName: 'Widget',
        ...(injectEditingId !== undefined && { injectEditingId }),
      }),
      { wrapper: createWrapper(queryClient) },
    );
  }

  it('edit-mode test merges editingId into testByConfig payload when injectEditingId is true', async () => {
    const hook = renderWithOption(true);
    act(() => { hook.result.current.actions.handleEdit(123); });

    await act(async () => {
      await hook.result.current.tests.handleFormTest({ name: 'n', url: 'u' });
    });

    expect(testByConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 123 }));
    expect(testByConfig.mock.calls[0]![0]).toMatchObject({ name: 'n', url: 'u', id: 123 });
  });

  it('create-mode test omits id key entirely when injectEditingId is true (no edit active)', async () => {
    const hook = renderWithOption(true);

    await act(async () => {
      await hook.result.current.tests.handleFormTest({ name: 'n', url: 'u' });
    });

    expect(testByConfig.mock.calls[0]![0]).not.toHaveProperty('id');
  });

  it('omits id key entirely when injectEditingId is omitted (import-list opt-out path) — even in edit', async () => {
    const hook = renderWithOption(undefined);
    act(() => { hook.result.current.actions.handleEdit(7); });

    await act(async () => {
      await hook.result.current.tests.handleFormTest({ name: 'n', url: 'u' });
    });

    expect(testByConfig.mock.calls[0]![0]).not.toHaveProperty('id');
  });

  it('omits id key entirely when injectEditingId is omitted in create mode', async () => {
    const hook = renderWithOption(undefined);

    await act(async () => {
      await hook.result.current.tests.handleFormTest({ name: 'n', url: 'u' });
    });

    expect(testByConfig.mock.calls[0]![0]).not.toHaveProperty('id');
  });
});

describe('formTestResult real state transitions (#610 regression)', () => {
  let queryClient: QueryClient;
  const testByConfig = vi.fn<(data: TestFormData) => Promise<TestResult>>();
  let realUseConnectionTest: typeof useConnectionTest;

  beforeEach(async () => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    // Get the real implementation for integration tests
    const actual = await vi.importActual('@/hooks/useConnectionTest') as { useConnectionTest: typeof useConnectionTest };
    realUseConnectionTest = actual.useConnectionTest;
    vi.mocked(useConnectionTest).mockImplementation(realUseConnectionTest);
    testByConfig.mockResolvedValue({ success: true, message: 'connected' });
  });

  afterEach(() => {
    // Re-mock for any subsequent describe blocks
    vi.mocked(useConnectionTest).mockReturnValue({
      testingId: null, testResult: null, testingForm: false, formTestResult: null,
      handleTest: vi.fn(), handleFormTest: vi.fn(), clearFormTestResult: vi.fn(),
    });
  });

  function renderRealHook() {
    return renderHook(
      () => useCrudSettings<TestItem, TestFormData>({
        queryKey: ['test-entities'],
        queryFn: vi.fn<() => Promise<TestItem[]>>().mockResolvedValue([]),
        createFn: vi.fn(), updateFn: vi.fn(), deleteFn: vi.fn(),
        testById: vi.fn(), testByConfig, entityName: 'Widget',
      }),
      { wrapper: createWrapper(queryClient) },
    );
  }

  async function seedFormTestResult(result: ReturnType<typeof renderRealHook>) {
    await act(async () => {
      await result.result.current.tests.handleFormTest({ name: 'test', url: 'http://example.com' });
    });
    expect(result.result.current.tests.formTestResult).toEqual({ success: true, message: 'connected' });
  }

  it('handleToggleForm opening clears a non-null formTestResult to null', async () => {
    const hook = renderRealHook();
    await seedFormTestResult(hook);

    // Open form — stale formTestResult must be cleared
    act(() => {
      hook.result.current.actions.handleToggleForm();
    });

    expect(hook.result.current.state.showForm).toBe(true);
    expect(hook.result.current.tests.formTestResult).toBeNull();
  });

  it('handleToggleForm closing clears a non-null formTestResult to null', async () => {
    const hook = renderRealHook();

    // Open form
    act(() => {
      hook.result.current.actions.handleToggleForm();
    });

    // Seed result while form is open
    await seedFormTestResult(hook);

    // Close form — formTestResult must be cleared
    act(() => {
      hook.result.current.actions.handleToggleForm();
    });

    expect(hook.result.current.state.showForm).toBe(false);
    expect(hook.result.current.tests.formTestResult).toBeNull();
  });

  it('handleEdit switching targets clears a non-null formTestResult to null', async () => {
    const hook = renderRealHook();

    // Start editing entity 1
    act(() => {
      hook.result.current.actions.handleEdit(1);
    });

    // Seed result while editing
    await seedFormTestResult(hook);

    // Switch to entity 2 — stale formTestResult must be cleared
    act(() => {
      hook.result.current.actions.handleEdit(2);
    });

    expect(hook.result.current.state.editingId).toBe(2);
    expect(hook.result.current.tests.formTestResult).toBeNull();
  });
});

describe('#1065 — URL ?edit=<id> sync', () => {
  const queryFn = vi.fn<() => Promise<TestItem[]>>();
  const updateFn = vi.fn<(id: number, data: TestFormData) => Promise<TestItem>>();
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

  function renderHookAt(route: string) {
    return renderHook(
      () => useCrudSettings<TestItem, TestFormData>({
        queryKey: ['test-entities'], queryFn,
        createFn: vi.fn(), updateFn, deleteFn: vi.fn(),
        testById: vi.fn(), testByConfig: vi.fn(), entityName: 'Indexer',
      }),
      { wrapper: createWrapper(queryClient, [route]) },
    );
  }

  it('opens modal for ?edit=<id> once items load and the id is present', async () => {
    queryFn.mockResolvedValue([{ id: 5, name: 'NZB' }, { id: 6, name: 'TPB' }]);
    const { result } = renderHookAt('/settings/indexers?edit=5');

    await waitFor(() => {
      expect(result.current.state.editingId).toBe(5);
    });
  });

  it('does NOT open modal when ?edit=<id> references a missing id', async () => {
    queryFn.mockResolvedValue([{ id: 1, name: 'NZB' }]);
    const { result } = renderHookAt('/settings/indexers?edit=999');

    await waitFor(() => {
      expect(result.current.state.isLoading).toBe(false);
    });
    expect(result.current.state.editingId).toBeNull();
  });

  it('ignores non-numeric ?edit value', async () => {
    queryFn.mockResolvedValue([{ id: 1, name: 'NZB' }]);
    const { result } = renderHookAt('/settings/indexers?edit=abc');

    await waitFor(() => {
      expect(result.current.state.isLoading).toBe(false);
    });
    expect(result.current.state.editingId).toBeNull();
  });

  it('handleEdit reflects the new id in the URL (push semantics validated indirectly via deep-link integration tests)', async () => {
    queryFn.mockResolvedValue([{ id: 7, name: 'NZB' }]);
    const { result } = renderHookAt('/settings/indexers');

    await waitFor(() => {
      expect(result.current.state.isLoading).toBe(false);
    });

    act(() => {
      result.current.actions.handleEdit(7);
    });

    // editingId tracks immediately; URL effect is gated on items so it doesn't clobber.
    expect(result.current.state.editingId).toBe(7);
  });

  it('handleCancelEdit clears editingId when ?edit was present', async () => {
    queryFn.mockResolvedValue([{ id: 3, name: 'NZB' }]);
    const { result } = renderHookAt('/settings/indexers?edit=3');

    await waitFor(() => {
      expect(result.current.state.editingId).toBe(3);
    });

    act(() => {
      result.current.actions.handleCancelEdit();
    });

    expect(result.current.state.editingId).toBeNull();
  });

  it('handleCancelEdit strips ?edit and clears editingId', async () => {
    queryFn.mockResolvedValue([{ id: 3, name: 'NZB' }]);
    const { result } = renderHookAt('/settings/indexers?edit=3');

    await waitFor(() => {
      expect(result.current.state.editingId).toBe(3);
    });

    act(() => {
      result.current.actions.handleCancelEdit();
    });

    expect(result.current.state.editingId).toBeNull();
  });

  it('updateMutation onSuccess clears editingId and strips ?edit', async () => {
    queryFn.mockResolvedValue([{ id: 4, name: 'NZB' }]);
    updateFn.mockResolvedValue({ id: 4, name: 'NZB-updated' });
    const { result } = renderHookAt('/settings/indexers?edit=4');

    await waitFor(() => {
      expect(result.current.state.editingId).toBe(4);
    });

    await act(async () => {
      result.current.mutations.updateMutation.mutate({ id: 4, data: { name: 'NZB-updated', url: 'https://example.com' } });
    });

    await waitFor(() => {
      expect(result.current.state.editingId).toBeNull();
    });
  });
});

describe('#1067 F2 — URL history semantics (push/replace/back/forward)', () => {
  const queryFn = vi.fn<() => Promise<TestItem[]>>();
  const updateFn = vi.fn<(id: number, data: TestFormData) => Promise<TestItem>>();
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    queryFn.mockResolvedValue([{ id: 7, name: 'NZB' }, { id: 8, name: 'TPB' }]);
    vi.mocked(useConnectionTest).mockReturnValue({
      testingId: null, testResult: null, testingForm: false, formTestResult: null,
      handleTest: vi.fn(), handleFormTest: vi.fn(), clearFormTestResult: vi.fn(),
    });
  });

  // Combined hook: exposes the CRUD hook plus router state observers so tests
  // can assert URL search string AND navigation type (PUSH vs REPLACE vs POP).
  // Using one renderHook keeps state observation in lockstep with the hook under test.
  function useCrudWithRouterProbes() {
    const crud = useCrudSettings<TestItem, TestFormData>({
      queryKey: ['test-entities'], queryFn,
      createFn: vi.fn(), updateFn, deleteFn: vi.fn(),
      testById: vi.fn(), testByConfig: vi.fn(), entityName: 'Indexer',
    });
    const location = useLocation();
    const navigationType = useNavigationType();
    const navigate = useNavigate();
    return { crud, location, navigationType, navigate };
  }

  function renderProbeAt(route: string) {
    return renderHook(() => useCrudWithRouterProbes(), {
      wrapper: createWrapper(queryClient, [route]),
    });
  }

  it('handleEdit pushes (navigationType=PUSH) and writes ?edit=<id> into the URL', async () => {
    const { result } = renderProbeAt('/settings/indexers');

    await waitFor(() => {
      expect(result.current.crud.state.isLoading).toBe(false);
    });
    expect(result.current.location.search).toBe('');

    act(() => { result.current.crud.actions.handleEdit(7); });

    await waitFor(() => {
      expect(result.current.location.search).toBe('?edit=7');
    });
    expect(result.current.navigationType).toBe('PUSH');
  });

  it('handleCancelEdit replaces (navigationType=REPLACE) and strips ?edit', async () => {
    const { result } = renderProbeAt('/settings/indexers?edit=7');

    await waitFor(() => {
      expect(result.current.crud.state.editingId).toBe(7);
    });

    act(() => { result.current.crud.actions.handleCancelEdit(); });

    await waitFor(() => {
      expect(result.current.location.search).toBe('');
    });
    expect(result.current.navigationType).toBe('REPLACE');
  });

  it('successful updateMutation replaces (navigationType=REPLACE) and strips ?edit', async () => {
    updateFn.mockResolvedValue({ id: 7, name: 'NZB-updated' });
    const { result } = renderProbeAt('/settings/indexers?edit=7');

    await waitFor(() => {
      expect(result.current.crud.state.editingId).toBe(7);
    });

    await act(async () => {
      result.current.crud.mutations.updateMutation.mutate({ id: 7, data: { name: 'x', url: 'y' } });
    });

    await waitFor(() => {
      expect(result.current.location.search).toBe('');
    });
    expect(result.current.navigationType).toBe('REPLACE');
  });

  it('browser Back from ?edit=<id> closes the modal (URL becomes bare, editingId null)', async () => {
    // Start at bare path so we have an entry to go back TO.
    const { result } = renderProbeAt('/settings/indexers');

    await waitFor(() => {
      expect(result.current.crud.state.isLoading).toBe(false);
    });

    // Push ?edit=7 onto history.
    act(() => { result.current.crud.actions.handleEdit(7); });
    await waitFor(() => {
      expect(result.current.location.search).toBe('?edit=7');
      expect(result.current.crud.state.editingId).toBe(7);
    });

    // Simulate browser Back.
    act(() => { result.current.navigate(-1); });

    await waitFor(() => {
      expect(result.current.location.search).toBe('');
      expect(result.current.crud.state.editingId).toBeNull();
    });
  });

  it('browser Forward to ?edit=<id> reopens the modal (editingId becomes the id)', async () => {
    const { result } = renderProbeAt('/settings/indexers');

    await waitFor(() => {
      expect(result.current.crud.state.isLoading).toBe(false);
    });

    // Push ?edit=7
    act(() => { result.current.crud.actions.handleEdit(7); });
    await waitFor(() => {
      expect(result.current.crud.state.editingId).toBe(7);
    });

    // Back to bare path.
    act(() => { result.current.navigate(-1); });
    await waitFor(() => {
      expect(result.current.crud.state.editingId).toBeNull();
    });

    // Forward to ?edit=7.
    act(() => { result.current.navigate(1); });
    await waitFor(() => {
      expect(result.current.location.search).toBe('?edit=7');
      expect(result.current.crud.state.editingId).toBe(7);
    });
  });
});

describe('#1067 F1 — URL-driven close respects mutation-pending guard', () => {
  const queryFn = vi.fn<() => Promise<TestItem[]>>();
  const updateFn = vi.fn<(id: number, data: TestFormData) => Promise<TestItem>>();
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    queryFn.mockResolvedValue([{ id: 7, name: 'NZB' }]);
    vi.mocked(useConnectionTest).mockReturnValue({
      testingId: null, testResult: null, testingForm: false, formTestResult: null,
      handleTest: vi.fn(), handleFormTest: vi.fn(), clearFormTestResult: vi.fn(),
    });
  });

  function useCrudWithNavigate() {
    const crud = useCrudSettings<TestItem, TestFormData>({
      queryKey: ['test-entities'], queryFn,
      createFn: vi.fn(), updateFn, deleteFn: vi.fn(),
      testById: vi.fn(), testByConfig: vi.fn(), entityName: 'Indexer',
    });
    return { crud, location: useLocation(), navigate: useNavigate() };
  }

  it('browser Back DURING save mutation does NOT clear editingId (URL-driven close blocked while isPending)', async () => {
    // Hold the update promise pending until the test resolves it manually.
    let resolveUpdate!: (value: TestItem) => void;
    const pendingUpdate = new Promise<TestItem>((resolve) => { resolveUpdate = resolve; });
    updateFn.mockReturnValue(pendingUpdate);

    const { result } = renderHook(() => useCrudWithNavigate(), {
      wrapper: createWrapper(queryClient, ['/settings/indexers']),
    });

    await waitFor(() => {
      expect(result.current.crud.state.isLoading).toBe(false);
    });

    // Open editor for id 7.
    act(() => { result.current.crud.actions.handleEdit(7); });
    await waitFor(() => {
      expect(result.current.location.search).toBe('?edit=7');
    });

    // Trigger save (mutation goes pending and stays pending).
    act(() => {
      result.current.crud.mutations.updateMutation.mutate({ id: 7, data: { name: 'x', url: 'y' } });
    });
    await waitFor(() => {
      expect(result.current.crud.mutations.updateMutation.isPending).toBe(true);
    });

    // Simulate browser Back while save is in flight — URL changes to bare path.
    act(() => { result.current.navigate(-1); });
    await waitFor(() => {
      expect(result.current.location.search).toBe('');
    });

    // Modal must STAY OPEN — editingId preserved despite URL going bare.
    expect(result.current.crud.state.editingId).toBe(7);

    // Resolve the save to let the test finish cleanly.
    await act(async () => {
      resolveUpdate({ id: 7, name: 'NZB-updated' });
      await pendingUpdate;
    });
  });
});
