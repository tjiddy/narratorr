import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { type TestResult } from '@/lib/api';
import { useConnectionTest } from '@/hooks/useConnectionTest';

export interface CrudSettingsConfig<TItem extends { id: number; name: string }, TFormData> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<TItem[]>;
  createFn: (data: TFormData) => Promise<TItem>;
  updateFn: (id: number, data: TFormData) => Promise<TItem>;
  deleteFn: (id: number) => Promise<unknown>;
  testById: (id: number) => Promise<TestResult>;
  testByConfig: (data: TFormData) => Promise<TestResult>;
  entityName: string;
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
}: CrudSettingsConfig<TItem, TFormData>) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TItem | null>(null);

  const connectionTest = useConnectionTest<TFormData>({ testById, testByConfig });

  const { data: items = [], isLoading } = useQuery({ queryKey, queryFn });

  const createMutation = useMutation({
    mutationFn: createFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setShowForm(false);
      toast.success(`${entityName} added successfully`);
    },
    onError: () => {
      toast.error(`Failed to add ${entityName.toLowerCase()}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: TFormData }) => updateFn(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setEditingId(null);
      toast.success(`${entityName} updated`);
    },
    onError: () => {
      toast.error(`Failed to update ${entityName.toLowerCase()}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(`${entityName} removed successfully`);
    },
    onError: () => {
      toast.error(`Failed to delete ${entityName.toLowerCase()}`);
    },
  });

  const handleToggleForm = useCallback(() => {
    if (showForm) {
      connectionTest.clearFormTestResult();
    } else {
      setEditingId(null);
    }
    setShowForm(!showForm);
  }, [showForm, connectionTest]);

  const handleEdit = useCallback((id: number) => {
    setShowForm(false);
    connectionTest.clearFormTestResult();
    setEditingId(id);
  }, [connectionTest]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    connectionTest.clearFormTestResult();
  }, [connectionTest]);

  return {
    items,
    isLoading,
    showForm,
    editingId,
    deleteTarget,
    setDeleteTarget,
    createMutation,
    updateMutation,
    deleteMutation,
    handleToggleForm,
    handleEdit,
    handleCancelEdit,
    ...connectionTest,
  };
}
