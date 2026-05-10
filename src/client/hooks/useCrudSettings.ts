import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { type TestResult } from '@/lib/api';
import { useConnectionTest } from '@/hooks/useConnectionTest';

function parseEditParam(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
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
  /**
   * Opt-in: when true, the editing entity id is merged into the testByConfig
   * payload during edit-mode connection tests so the server can resolve sentinel
   * placeholders for masked secret fields. Leave unset for adapters whose test
   * endpoint does not accept an id (e.g. import lists, which test by saved id
   * via a separate route).
   */
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

  // URL → state: sync editingId from ?edit=<id> when items have loaded.
  // Gated on items having loaded so we don't (a) clear editingId during the brief
  // window between handleEdit's setEditingId call and the URL update, and
  // (b) optimistically open with a stale id before items load.
  // setState inside the effect is intentional here: URL is an external state
  // source (browser back/forward + deep-link), and React state must mirror it.
  const editParam = parseEditParam(searchParams.get('edit'));
  useEffect(() => {
    if (items.length === 0) return;

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
  }, [editParam, items, editingId]);

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
    onError: () => {
      toast.error(`Failed to add ${entityName.toLowerCase()}`);
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
    connectionTest.clearFormTestResult();
    if (!showForm) {
      // Opening create form — clear any active edit AND strip ?edit so the URL
      // doesn't re-open the modal once items load.
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
