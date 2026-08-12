import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, type TestResult } from '@/lib/api';
import { useConnectionTest } from '@/hooks/useConnectionTest';

function parseEditParam(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Only ApiError carries trusted server validation copy; network failures keep generic text.
function withApiMessage(prefix: string, error: unknown): string {
  return error instanceof ApiError ? `${prefix}: ${error.message}` : prefix;
}

export interface CrudSettingsConfig<TItem extends { id: number; name: string }, TFormData> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<TItem[]>;
  createFn: (data: TFormData) => Promise<TItem>;
  updateFn: (id: number, data: TFormData) => Promise<TItem>;
  deleteFn: (id: number) => Promise<unknown>;
  testById: (id: number) => Promise<TestResult>;
  testByConfig: (data: TFormData) => Promise<TestResult>;
  entityName: string;
  /** Include the editing ID only for test endpoints that resolve masked-secret sentinels. */
  injectEditingId?: boolean;
}

export function useCrudSettings<TItem extends { id: number; name: string }, TFormData>({
  queryKey,
  queryFn,
  createFn,
  updateFn,
  deleteFn,
  testById,
  testByConfig,
  entityName,
  injectEditingId,
}: CrudSettingsConfig<TItem, TFormData>) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TItem | null>(null);

  const connectionTest = useConnectionTest<TFormData>({
    testById,
    testByConfig,
    invalidateOnSuccess: queryKey as string[],
    entityId: injectEditingId && editingId !== null ? editingId : undefined,
  });

  const { data: items = [], isLoading } = useQuery({ queryKey, queryFn });

  const stripEditParam = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('edit');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const createMutation = useMutation({
    mutationFn: createFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setShowForm(false);
      toast.success(`${entityName} added successfully`);
    },
    onError: (error) => {
      toast.error(withApiMessage(`Failed to add ${entityName.toLowerCase()}`, error));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: TFormData }) => updateFn(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setEditingId(null);
      stripEditParam();
      toast.success(`${entityName} updated`);
    },
    onError: (error, variables) => {
      // Restore ?edit if Back removed it during save, keeping the failed form recoverable.
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('edit', String(variables.id));
        return next;
      }, { replace: true });
      toast.error(withApiMessage(`Failed to update ${entityName.toLowerCase()}`, error));
    },
  });

  // Mirror ?edit only after items load and while saves are idle; Back cannot close an in-flight edit.
  const editParam = parseEditParam(searchParams.get('edit'));
  const isSavePending = createMutation.isPending || updateMutation.isPending;
  useEffect(() => {
    if (items.length === 0) return;
    if (isSavePending) return;

    if (editParam === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirroring external URL state on browser back/forward
      if (editingId !== null) setEditingId(null);
      return;
    }

    if (editingId === editParam) return;

    if (items.some((item) => item.id === editParam)) {
      setShowForm(false);
      setEditingId(editParam);
    }
  }, [editParam, items, editingId, isSavePending]);

  const deleteMutation = useMutation({
    mutationFn: deleteFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(`${entityName} removed successfully`);
    },
    onError: (error) => {
      toast.error(withApiMessage(`Failed to delete ${entityName.toLowerCase()}`, error));
    },
  });

  const handleToggleForm = useCallback(() => {
    connectionTest.clearFormTestResult();
    if (!showForm) {
      if (editingId !== null) {
        setEditingId(null);
        stripEditParam();
      }
    }
    setShowForm(!showForm);
  }, [showForm, editingId, connectionTest, stripEditParam]);

  const handleEdit = useCallback((id: number) => {
    setShowForm(false);
    connectionTest.clearFormTestResult();
    setEditingId(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('edit', String(id));
      return next;
    });
  }, [connectionTest, setSearchParams]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    connectionTest.clearFormTestResult();
    stripEditParam();
  }, [connectionTest, stripEditParam]);

  return {
    state: {
      items,
      isLoading,
      showForm,
      editingId,
      deleteTarget,
    },
    actions: {
      setDeleteTarget,
      handleToggleForm,
      handleEdit,
      handleCancelEdit,
    },
    mutations: {
      createMutation,
      updateMutation,
      deleteMutation,
    },
    tests: connectionTest,
  };
}
