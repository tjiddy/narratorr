import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportList, type ImportListItem } from '@/lib/api';
import { importListItemKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { queryKeys } from '@/lib/queryKeys';
import { useCrudSettings } from '@/hooks/useCrudSettings';
import { ConfirmModal } from '@/components/ConfirmModal';
import {
  LoadingSpinner,
  ListIcon,
  PlusIcon,
  XIcon,
  TrashIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  EyeIcon,
} from '@/components/icons';
import { IMPORT_LIST_REGISTRY } from '../../../shared/import-list-registry.js';
import { ProviderSettings } from './ImportListProviderSettings.js';

type ImportListFormData = {
  name: string;
  type: 'abs' | 'nyt' | 'hardcover';
  enabled: boolean;
  syncIntervalMinutes: number;
  settings: Record<string, unknown>;
};

const inputClass = 'w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary';
const btnSecondary = 'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';

function getDefaults(initial?: ImportList) {
  const type = initial?.type ?? 'abs';
  return {
    type,
    name: initial?.name ?? '',
    enabled: initial?.enabled ?? true,
    syncInterval: initial?.syncIntervalMinutes ?? 1440,
    settings: initial?.settings ?? IMPORT_LIST_REGISTRY[type]?.defaultSettings ?? {},
  };
}

function ImportListForm({
  onSubmit,
  isPending,
  initial,
}: {
  onSubmit: (data: ImportListFormData) => void;
  isPending: boolean;
  initial?: ImportList;
}) {
  const defaults = getDefaults(initial);
  const [type, setType] = useState<ImportListFormData['type']>(defaults.type);
  const [name, setName] = useState(defaults.name);
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [syncInterval, setSyncInterval] = useState(defaults.syncInterval);
  const [settings, setSettings] = useState<Record<string, unknown>>(defaults.settings);

  // Preview state — intentionally local (not part of generic CRUD hook)
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [previewItems, setPreviewItems] = useState<ImportListItem[] | null>(null);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  function handleTypeChange(newType: ImportListFormData['type']) {
    const newMeta = IMPORT_LIST_REGISTRY[newType];
    setType(newType);
    setSettings(newMeta?.defaultSettings ?? {});
    if (!name || name === (IMPORT_LIST_REGISTRY[type]?.label ?? '')) setName(newMeta?.label ?? '');
    setTestResult(null);
    setPreviewItems(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = initial
        ? await api.testImportList(initial.id)
        : await api.testImportListConfig({ name, type, enabled, syncIntervalMinutes: syncInterval, settings });
      setTestResult(result);
    } catch {
      setTestResult({ success: false, message: 'Test request failed' });
    } finally {
      setTesting(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    setPreviewItems(null);
    try {
      const result = await api.previewImportList({ name, type, enabled, syncIntervalMinutes: syncInterval, settings });
      setPreviewItems(result.items);
      setPreviewTotal(result.total);
    } catch {
      toast.error('Preview failed — check your settings');
    } finally {
      setPreviewing(false);
    }
  }

  const submitLabel = isPending ? 'Saving...' : initial ? 'Update' : 'Add Import List';

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ name, type, enabled, syncIntervalMinutes: syncInterval, settings }); }}
      className="glass-card rounded-2xl p-6 space-y-4"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="il-name" className="block text-sm font-medium mb-1">Name</label>
          <input id="il-name" type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required />
        </div>
        {!initial && (
          <div>
            <label htmlFor="il-type" className="block text-sm font-medium mb-1">Provider Type</label>
            <select id="il-type" value={type} onChange={(e) => handleTypeChange(e.target.value as ImportListFormData['type'])} className={inputClass}>
              {Object.entries(IMPORT_LIST_REGISTRY).map(([key, m]) => (
                <option key={key} value={key}>{m.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="il-syncInterval" className="block text-sm font-medium mb-1">Sync Interval (minutes)</label>
        <input id="il-syncInterval" type="number" value={syncInterval} onChange={(e) => setSyncInterval(Number(e.target.value))} min={5} className={inputClass} />
      </div>

      <ProviderSettings type={type} settings={settings} onChange={setSettings} />

      {/* Test + Preview actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className={`${btnSecondary} bg-muted hover:bg-muted/80`}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          type="button"
          onClick={handlePreview}
          disabled={previewing}
          className={`${btnSecondary} bg-muted hover:bg-muted/80 inline-flex items-center gap-1.5`}
        >
          <EyeIcon className="w-3.5 h-3.5" />
          {previewing ? 'Loading...' : 'Preview Items'}
        </button>
        {testResult && (
          <span className={`text-sm ${testResult.success ? 'text-green-500' : 'text-destructive'}`}>
            {testResult.success ? 'Connection OK' : testResult.message || 'Test failed'}
          </span>
        )}
      </div>

      {/* Preview results */}
      {previewItems && (
        <div className="border border-border rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
          <p className="text-xs text-muted-foreground mb-2">
            Showing {previewItems.length} of {previewTotal} items
          </p>
          {previewItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items found</p>
          ) : (
            (() => {
              const previewKeys = deduplicateKeys(previewItems.map(importListItemKey));
              return previewItems.map((item, idx) => (
                <div key={previewKeys[idx]} className="text-sm">
                  <span className="font-medium">{item.title}</span>
                  {item.author && <span className="text-muted-foreground"> by {item.author}</span>}
                </div>
              ));
            })()
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <label htmlFor="il-enabled" className="flex items-center gap-2 cursor-pointer">
          <input id="il-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="sr-only peer" />
          <div className="w-9 h-5 bg-muted rounded-full peer peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4 relative" />
          <span className="text-sm">Enabled</span>
        </label>
        <button type="submit" disabled={isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-all">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function ImportListRow({
  list,
  onToggle,
  onEdit,
  onDelete,
}: {
  list: ImportList;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onToggle} className="shrink-0">
          {list.enabled
            ? <CheckCircleIcon className="w-5 h-5 text-green-500" />
            : <AlertCircleIcon className="w-5 h-5 text-muted-foreground" />}
        </button>
        <div>
          <p className="font-medium">{list.name}</p>
          <p className="text-sm text-muted-foreground">
            {IMPORT_LIST_REGISTRY[list.type]?.label ?? list.type}
            {' \u00b7 '}
            every {list.syncIntervalMinutes}m
            {list.lastSyncError && (
              <span className="text-destructive ml-2">{list.lastSyncError}</span>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onEdit} className="px-3 py-1.5 text-sm bg-muted rounded-lg hover:bg-muted/80 transition-colors">
          Edit
        </button>
        <button type="button" onClick={onDelete} className="p-1.5 text-muted-foreground hover:text-destructive transition-colors">
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function ImportListsSettings() {
  const queryClient = useQueryClient();

  const { state, actions, mutations } = useCrudSettings<ImportList, ImportListFormData>({
    queryKey: queryKeys.importLists(),
    queryFn: api.getImportLists,
    createFn: api.createImportList,
    updateFn: api.updateImportList,
    deleteFn: api.deleteImportList,
    testById: api.testImportList,
    testByConfig: api.testImportListConfig,
    entityName: 'Import list',
  });
  const { items: lists, isLoading, showForm, editingId, deleteTarget } = state;
  const { setDeleteTarget, handleToggleForm, handleEdit, handleCancelEdit } = actions;
  const { createMutation, updateMutation, deleteMutation } = mutations;

  // Toggle mutation — bespoke, not part of generic CRUD hook
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.updateImportList(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.importLists() }),
    onError: () => toast.error('Failed to toggle import list'),
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <ListIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Import Lists</h2>
            <p className="text-sm text-muted-foreground">Auto-add books from external sources</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleToggleForm}
          className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
            showForm
              ? 'bg-muted text-muted-foreground hover:bg-muted/80'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          }`}
        >
          {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Import List'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <ImportListForm
          onSubmit={(data) => createMutation.mutate(data)}
          isPending={createMutation.isPending}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : lists.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <ListIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No import lists configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add an import list to automatically discover books from Audiobookshelf, NYT, or Hardcover
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {lists.map((list) => (
            <div key={list.id} className="glass-card rounded-xl p-4">
              {editingId === list.id ? (
                <div className="space-y-3">
                  <ImportListForm
                    initial={list}
                    onSubmit={(data) => updateMutation.mutate({ id: list.id, data })}
                    isPending={updateMutation.isPending}
                  />
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel editing
                  </button>
                </div>
              ) : (
                <ImportListRow
                  list={list}
                  onToggle={() => toggleMutation.mutate({ id: list.id, enabled: !list.enabled })}
                  onEdit={() => handleEdit(list.id)}
                  onDelete={() => setDeleteTarget(list)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmModal
        isOpen={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name ?? ''}?`}
        message="This will remove the import list. Books already imported will not be affected."
        confirmLabel="Delete"
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
