import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportList, type ImportListItem, type TestResult } from '@/lib/api';
import { compactInputClass as inputClass } from '@/components/settings/formStyles';
import { importListItemKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { queryKeys } from '@/lib/queryKeys';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import {
  CheckCircleIcon,
  AlertCircleIcon,
  EyeIcon,
  TrashIcon,
} from '@/components/icons';
import { IMPORT_LIST_REGISTRY } from '../../../shared/import-list-registry.js';
import { ProviderSettings } from '../../pages/settings/ImportListProviderSettings.js';
import type { IdTestResult } from './SettingsCardShell';

export type ImportListFormData = {
  name: string;
  type: 'abs' | 'nyt' | 'hardcover';
  enabled: boolean;
  syncIntervalMinutes: number;
  settings: Record<string, unknown>;
};

interface ImportListCardProps {
  list?: ImportList;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: ImportListFormData) => void;
  onFormTest?: (data: ImportListFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
}

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

function PreviewResults({ items, total }: { items: ImportListItem[]; total: number }) {
  if (items.length === 0) {
    return (
      <div className="border border-border rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
        <p className="text-xs text-muted-foreground mb-2">Showing 0 of {total} items</p>
        <p className="text-sm text-muted-foreground">No items found</p>
      </div>
    );
  }
  const previewKeys = deduplicateKeys(items.map(importListItemKey));
  return (
    <div className="border border-border rounded-lg p-3 space-y-1 max-h-48 overflow-y-auto">
      <p className="text-xs text-muted-foreground mb-2">Showing {items.length} of {total} items</p>
      {items.map((item, idx) => (
        <div key={previewKeys[idx]} className="text-sm">
          <span className="font-medium">{item.title}</span>
          {item.author && <span className="text-muted-foreground"> by {item.author}</span>}
        </div>
      ))}
    </div>
  );
}

function ImportListFormToolbar({
  isTesting, onTest, previewing, onPreview, testResult,
}: {
  isTesting: boolean;
  onTest: () => void;
  previewing: boolean;
  onPreview: () => void;
  testResult: TestResult | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" onClick={onTest} disabled={isTesting} className={`${btnSecondary} bg-muted hover:bg-muted/80`}>
        {isTesting ? 'Testing...' : 'Test Connection'}
      </button>
      <button type="button" onClick={onPreview} disabled={previewing} className={`${btnSecondary} bg-muted hover:bg-muted/80 inline-flex items-center gap-1.5`}>
        <EyeIcon className="w-3.5 h-3.5" />
        {previewing ? 'Loading...' : 'Preview Items'}
      </button>
      {testResult && (
        <span className={`text-sm ${testResult.success ? 'text-green-500' : 'text-destructive'}`}>
          {testResult.success ? 'Connection OK' : testResult.message || 'Test failed'}
        </span>
      )}
    </div>
  );
}

function ImportListFormFooter({
  enabled, onEnabledChange, onCancel, isPending, submitLabel,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onCancel?: () => void;
  isPending: boolean;
  submitLabel: string;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <label htmlFor="il-enabled" className="flex items-center gap-2 cursor-pointer">
        <ToggleSwitch id="il-enabled" size="compact" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} />
        <span className="text-sm">Enabled</span>
      </label>
      <div className="flex items-center gap-3">
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-4 py-2 border border-border rounded-lg text-muted-foreground hover:bg-muted transition-all">
            Cancel
          </button>
        )}
        <button type="submit" disabled={isPending} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 transition-all">
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function ImportListForm({
  onSubmit,
  onCancel,
  isPending,
  initial,
  onFormTest,
  onTest,
  testingForm,
  formTestResult,
  testingId,
  testResult,
}: {
  onSubmit: (data: ImportListFormData) => void;
  onCancel?: () => void;
  isPending: boolean;
  initial?: ImportList;
  onFormTest?: (data: ImportListFormData) => void;
  onTest?: (id: number) => void;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  testingId?: number | null;
  testResult?: IdTestResult | null;
}) {
  const defaults = getDefaults(initial);
  const [type, setType] = useState<ImportListFormData['type']>(defaults.type);
  const [name, setName] = useState(defaults.name);
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [syncInterval, setSyncInterval] = useState(defaults.syncInterval);
  const [settings, setSettings] = useState<Record<string, unknown>>(defaults.settings);

  // Preview state — local only (not part of generic CRUD hook)
  const [previewItems, setPreviewItems] = useState<ImportListItem[] | null>(null);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  // Track whether test result is stale (provider changed since last test)
  const [testResultStale, setTestResultStale] = useState(false);

  function handleTypeChange(newType: ImportListFormData['type']) {
    const newMeta = IMPORT_LIST_REGISTRY[newType];
    setType(newType);
    setSettings(newMeta?.defaultSettings ?? {});
    if (!name || name === (IMPORT_LIST_REGISTRY[type]?.label ?? '')) setName(newMeta?.label ?? '');
    setPreviewItems(null);
    setTestResultStale(true);
  }

  const formData = { name, type, enabled, syncIntervalMinutes: syncInterval, settings };

  function handleTest() {
    setTestResultStale(false);
    if (initial && onTest) onTest(initial.id);
    else onFormTest?.(formData);
  }

  async function handlePreview() {
    setPreviewing(true);
    setPreviewItems(null);
    const result = await api.previewImportList(formData).catch(() => null);
    if (result) { setPreviewItems(result.items); setPreviewTotal(result.total); }
    else toast.error('Preview failed — check your settings');
    setPreviewing(false);
  }

  const isTesting = initial ? testingId === initial.id : !!testingForm;
  const currentTestResult = testResultStale ? null : (initial
    ? (testResult?.id === initial.id ? testResult : null)
    : formTestResult ?? null);

  const submitLabel = isPending ? 'Saving...' : (initial ? 'Update' : 'Add Import List');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(formData);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5"
    >
      <h3 className="font-display text-lg font-semibold">
        {initial ? 'Edit Import List' : 'Add Import List'}
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="il-name" className="block text-sm font-medium mb-1">Name</label>
          <input id="il-name" type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required />
        </div>
        {!initial && (
          <div>
            <label htmlFor="il-type" className="block text-sm font-medium mb-1">Provider Type</label>
            <SelectWithChevron id="il-type" value={type} onChange={(e) => handleTypeChange(e.target.value as ImportListFormData['type'])}>
              {Object.entries(IMPORT_LIST_REGISTRY).map(([key, m]) => (
                <option key={key} value={key}>{m.label}</option>
              ))}
            </SelectWithChevron>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="il-syncInterval" className="block text-sm font-medium mb-1">Sync Interval (minutes)</label>
        <input id="il-syncInterval" type="number" value={syncInterval} onChange={(e) => setSyncInterval(Number(e.target.value))} min={5} className={inputClass} />
      </div>

      <ProviderSettings type={type} settings={settings} onChange={setSettings} />

      <ImportListFormToolbar
        isTesting={isTesting}
        onTest={handleTest}
        previewing={previewing}
        onPreview={handlePreview}
        testResult={currentTestResult}
      />

      {previewItems && <PreviewResults items={previewItems} total={previewTotal} />}

      <ImportListFormFooter
        enabled={enabled}
        onEnabledChange={setEnabled}
        onCancel={onCancel}
        isPending={isPending}
        submitLabel={submitLabel}
      />
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

export function ImportListCard(props: ImportListCardProps) {
  const {
    list, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest, onTest,
    isPending, testingId, testResult, testingForm, formTestResult,
  } = props;

  const queryClient = useQueryClient();

  // Toggle mutation — self-contained for view mode
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.updateImportList(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.importLists() }),
    onError: () => toast.error('Failed to toggle import list'),
  });

  if (mode === 'view' && list) {
    return (
      <div
        className="glass-card rounded-2xl p-5 animate-fade-in-up"
        style={props.animationDelay ? { animationDelay: props.animationDelay } : undefined}
      >
        <ImportListRow
          list={list}
          onToggle={() => toggleMutation.mutate({ id: list.id, enabled: !list.enabled })}
          onEdit={() => onEdit?.()}
          onDelete={() => onDelete?.()}
        />
      </div>
    );
  }

  return (
    <ImportListForm
      initial={list}
      onSubmit={onSubmit}
      onCancel={onCancel}
      isPending={!!isPending}
      onFormTest={onFormTest}
      onTest={onTest}
      testingForm={testingForm}
      formTestResult={formTestResult}
      testingId={testingId}
      testResult={testResult}
    />
  );
}
