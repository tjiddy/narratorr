import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ProwlarrConfig, type SyncPreviewItem } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import {
  LoadingSpinner,
  CheckIcon,
  XIcon,
  AlertCircleIcon,
} from '@/components/icons';

type SyncAction = SyncPreviewItem['action'];

const ACTION_LABELS: Record<SyncAction, string> = {
  new: 'New',
  updated: 'Updated',
  unchanged: 'Unchanged',
  removed: 'Removed',
};

const ACTION_STYLES: Record<SyncAction, string> = {
  new: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  updated: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  unchanged: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  removed: 'bg-red-500/15 text-red-400 border-red-500/20',
};

function SyncActionBadge({ action }: { action: SyncAction }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border ${ACTION_STYLES[action]}`}>
      {ACTION_LABELS[action]}
    </span>
  );
}

type Step = 'connect' | 'loading' | 'select';

interface ProwlarrImportProps {
  isOpen: boolean;
  onClose: () => void;
}

// eslint-disable-next-line max-lines-per-function, complexity -- multi-step wizard (connect, select, sync) with independent state per step
export function ProwlarrImport({ isOpen, onClose }: ProwlarrImportProps) {
  const queryClient = useQueryClient();
  const modalRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>('connect');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [syncMode, setSyncMode] = useState<'addOnly' | 'fullSync'>('addOnly');
  const [categories, setCategories] = useState('3030');
  const [testPassed, setTestPassed] = useState(false);
  const [previewItems, setPreviewItems] = useState<SyncPreviewItem[]>([]);
  const [selections, setSelections] = useState<Record<number, boolean>>({});

  useEscapeKey(isOpen, onClose, modalRef);

  // Reset wizard state when modal opens (keep config fields)
  const [prevIsOpen, setPrevIsOpen] = useState(false);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setStep('connect');
      setPreviewItems([]);
      setSelections({});
    }
  }

  // Load existing config into form
  useQuery({
    queryKey: [...queryKeys.prowlarr.config(), 'form'],
    queryFn: async () => {
      try {
        const config = await api.prowlarrGetConfig();
        setUrl(config.url);
        setApiKey(config.apiKey);
        setSyncMode(config.syncMode);
        setCategories(config.categories.join(', '));
        return config;
      } catch {
        return null;
      }
    },
    enabled: isOpen,
    retry: false,
    staleTime: Infinity,
  });

  const testMutation = useMutation({
    mutationFn: () => api.prowlarrTestConnection(url, apiKey),
    onSuccess: (result) => {
      if (result.success) {
        setTestPassed(true);
        toast.success('Connected to Prowlarr');
      } else {
        setTestPassed(false);
        toast.error(`Connection failed: ${result.message || 'Unknown error'}`);
      }
    },
    onError: (err) => {
      setTestPassed(false);
      toast.error(`Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    },
  });

  const handleNext = useCallback(async () => {
    setStep('loading');
    try {
      const config: ProwlarrConfig = {
        url: url.replace(/\/+$/, ''),
        apiKey,
        syncMode,
        categories: categories.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
      };
      await api.prowlarrSaveConfig(config);
      const items = await api.prowlarrPreview();
      setPreviewItems(items);
      const defaultSelections: Record<number, boolean> = {};
      for (const item of items) {
        defaultSelections[item.prowlarrId] = item.action !== 'unchanged';
      }
      setSelections(defaultSelections);
      setStep('select');
    } catch (err) {
      toast.error(`Preview failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setStep('connect');
    }
  }, [url, apiKey, syncMode, categories]);

  const syncMutation = useMutation({
    mutationFn: () =>
      api.prowlarrSync({
        items: previewItems.map(item => ({
          prowlarrId: item.prowlarrId,
          action: item.action,
          selected: selections[item.prowlarrId] ?? false,
        })),
      }),
    onSuccess: (result) => {
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.removed > 0) parts.push(`${result.removed} removed`);
      toast.success(parts.length > 0 ? `Sync complete: ${parts.join(', ')}` : 'No changes applied');
      queryClient.invalidateQueries({ queryKey: queryKeys.indexers() });
      onClose();
    },
    onError: (err) => {
      toast.error(`Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    },
  });

  const handleToggleSelection = useCallback((prowlarrId: number) => {
    setSelections(prev => ({ ...prev, [prowlarrId]: !prev[prowlarrId] }));
  }, []);

  const hasSelections = previewItems.some(
    item => item.action !== 'unchanged' && selections[item.prowlarrId],
  );

  const changeCount = previewItems.filter(i => i.action !== 'unchanged').length;

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prowlarr-title"
        className="relative w-full max-w-lg glass-card rounded-2xl shadow-2xl animate-fade-in-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
          <div>
            <h3 id="prowlarr-title" className="font-display text-lg font-semibold">
              Import from Prowlarr
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              {step === 'select' ? 'Select indexers to import' : 'Connect to your Prowlarr instance'}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="p-2 rounded-lg hover:bg-muted/80 transition-colors -mr-2"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex gap-1.5 px-6 pb-4">
          <div className={`h-1 flex-1 rounded-full transition-colors ${step === 'connect' ? 'bg-primary' : 'bg-primary/30'}`} />
          <div className={`h-1 flex-1 rounded-full transition-colors ${step === 'select' ? 'bg-primary' : 'bg-border/50'}`} />
        </div>

        {/* Step 1: Connect */}
        {step === 'connect' && (
          <div className="px-6 pb-6 space-y-4">
            <div>
              <label htmlFor="prowlarrUrl" className="block text-sm font-medium mb-1.5">Prowlarr URL</label>
              <input
                id="prowlarrUrl"
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setTestPassed(false); }}
                placeholder="http://localhost:9696"
                className="w-full px-3 py-2 bg-background border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
            </div>

            <div>
              <label htmlFor="prowlarrApiKey" className="block text-sm font-medium mb-1.5">API Key</label>
              <input
                id="prowlarrApiKey"
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setTestPassed(false); }}
                placeholder="Your Prowlarr API key"
                className="w-full px-3 py-2 bg-background border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-1.5">Sync Mode</label>
                <div className="flex rounded-xl border border-border/50 overflow-hidden">
                  {(['addOnly', 'fullSync'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setSyncMode(mode)}
                      className={`flex-1 px-3 py-2 text-sm font-medium transition-all ${
                        syncMode === mode
                          ? 'bg-primary/15 text-primary'
                          : 'bg-background text-muted-foreground hover:text-foreground hover:bg-muted/30'
                      } ${mode === 'addOnly' ? 'border-r border-border/50' : ''}`}
                    >
                      {mode === 'addOnly' ? 'Add Only' : 'Full Sync'}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {syncMode === 'addOnly'
                    ? 'Only import new indexers'
                    : 'Add, update, and remove to match Prowlarr'}
                </p>
              </div>

              <div>
                <label htmlFor="prowlarrCategories" className="block text-sm font-medium mb-1.5">Categories</label>
                <input
                  id="prowlarrCategories"
                  type="text"
                  value={categories}
                  onChange={(e) => setCategories(e.target.value)}
                  placeholder="3030"
                  className="w-full px-3 py-2 bg-background border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  3030 = Audiobook.{' '}
                  <a
                    href="https://wiki.servarr.com/prowlarr/supported-indexers"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Reference
                  </a>
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-between pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2.5 text-sm font-medium border border-border rounded-xl hover:bg-muted transition-all"
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => testMutation.mutate()}
                  disabled={!url || !apiKey || testMutation.isPending}
                  className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-xl border border-border/50 hover:bg-muted/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {testMutation.isPending ? (
                    <LoadingSpinner className="w-3.5 h-3.5" />
                  ) : testPassed ? (
                    <CheckIcon className="w-3.5 h-3.5 text-emerald-400" />
                  ) : testMutation.isSuccess && !testMutation.data.success ? (
                    <AlertCircleIcon className="w-3.5 h-3.5 text-red-400" />
                  ) : null}
                  Test
                </button>
                <button
                  onClick={handleNext}
                  disabled={!url || !apiKey || !testPassed}
                  title={!testPassed ? 'Test connection first' : undefined}
                  className="px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {step === 'loading' && (
          <div className="px-6 pb-6 flex flex-col items-center justify-center py-12">
            <LoadingSpinner className="w-8 h-8 text-primary mb-3" />
            <p className="text-sm text-muted-foreground">Fetching indexers from Prowlarr...</p>
          </div>
        )}

        {/* Step 2: Select */}
        {step === 'select' && (
          <div className="pb-6 space-y-4">
            {previewItems.length === 0 ? (
              <div className="px-6 py-8 text-center">
                <p className="text-muted-foreground">No indexers found matching your categories.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-6">
                  <span className="text-sm text-muted-foreground">
                    {previewItems.length} indexer{previewItems.length !== 1 ? 's' : ''}
                    {changeCount > 0 && <> &middot; {changeCount} change{changeCount !== 1 ? 's' : ''}</>}
                  </span>
                  {previewItems.some(i => i.action === 'removed') && (
                    <span className="flex items-center gap-1.5 text-xs text-amber-400">
                      <AlertCircleIcon className="w-3.5 h-3.5" />
                      Removals are destructive
                    </span>
                  )}
                </div>

                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
                      <tr className="text-muted-foreground text-xs uppercase tracking-wider border-b border-border/30">
                        <th className="py-2 px-6 text-left font-medium w-10"></th>
                        <th className="py-2 px-2 text-left font-medium">Indexer</th>
                        <th className="py-2 px-2 text-left font-medium">Type</th>
                        <th className="py-2 px-2 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                      {previewItems.map((item, idx) => (
                        <tr
                          key={item.prowlarrId}
                          className={`transition-colors animate-fade-in-up ${
                            item.action === 'unchanged' ? 'opacity-40' : 'hover:bg-muted/20'
                          }`}
                          style={{ animationDelay: `${idx * 30}ms` }}
                        >
                          <td className="py-2.5 px-6">
                            {item.action !== 'unchanged' && (
                              <input
                                type="checkbox"
                                checked={selections[item.prowlarrId] ?? false}
                                onChange={() => handleToggleSelection(item.prowlarrId)}
                                className="rounded border-border/50 bg-background text-primary focus:ring-primary/30 cursor-pointer"
                              />
                            )}
                          </td>
                          <td className="py-2.5 px-2 font-medium">{item.name}</td>
                          <td className="py-2.5 px-2">
                            <span className="text-xs font-mono text-muted-foreground uppercase">
                              {item.type}
                            </span>
                          </td>
                          <td className="py-2.5 px-2">
                            <SyncActionBadge action={item.action} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Footer */}
            <div className="flex justify-between gap-3 px-6 pt-2">
              <button
                onClick={() => setStep('connect')}
                className="px-4 py-2.5 text-sm font-medium border border-border rounded-xl hover:bg-muted transition-all"
              >
                Back
              </button>
              <button
                onClick={() => syncMutation.mutate()}
                disabled={!hasSelections || syncMutation.isPending}
                className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {syncMutation.isPending && <LoadingSpinner className="w-4 h-4" />}
                Import Selected
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
