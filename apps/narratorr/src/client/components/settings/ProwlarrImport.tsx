import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ProwlarrConfig, type SyncPreviewItem } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import {
  LoadingSpinner,
  CheckIcon,
  XIcon,
  AlertCircleIcon,
  RefreshIcon,
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

interface ProwlarrImportProps {
  onClose: () => void;
}

export function ProwlarrImport({ onClose }: ProwlarrImportProps) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [syncMode, setSyncMode] = useState<'addOnly' | 'fullSync'>('addOnly');
  const [categories, setCategories] = useState('3030');
  const [isConfigured, setIsConfigured] = useState(false);
  const [testPassed, setTestPassed] = useState(false);
  const [previewItems, setPreviewItems] = useState<SyncPreviewItem[] | null>(null);
  const [selections, setSelections] = useState<Record<number, boolean>>({});

  // Load existing config into form
  useQuery({
    queryKey: [...queryKeys.prowlarr.config(), 'form'],
    queryFn: async () => {
      try {
        const config = await api.getConfig();
        setUrl(config.url);
        setApiKey(config.apiKey);
        setSyncMode(config.syncMode);
        setCategories(config.categories.join(', '));
        setIsConfigured(true);
        return config;
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: Infinity,
  });

  const testMutation = useMutation({
    mutationFn: () => api.testConnection(url, apiKey),
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

  const saveMutation = useMutation({
    mutationFn: () => {
      const config: ProwlarrConfig = {
        url: url.replace(/\/+$/, ''),
        apiKey,
        syncMode,
        categories: categories.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
      };
      return api.saveConfig(config);
    },
    onSuccess: () => {
      setIsConfigured(true);
      toast.success('Prowlarr config saved');
    },
    onError: (err) => {
      toast.error(`Failed to save config: ${err instanceof Error ? err.message : 'Unknown error'}`);
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => api.preview(),
    onSuccess: (items) => {
      setPreviewItems(items);
      const defaultSelections: Record<number, boolean> = {};
      for (const item of items) {
        defaultSelections[item.prowlarrId] = item.action !== 'unchanged';
      }
      setSelections(defaultSelections);
    },
    onError: (err) => {
      toast.error(`Preview failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => {
      if (!previewItems) throw new Error('No preview data');
      return api.sync({
        items: previewItems.map(item => ({
          prowlarrId: item.prowlarrId,
          action: item.action,
          selected: selections[item.prowlarrId] ?? false,
        })),
      });
    },
    onSuccess: (result) => {
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.removed > 0) parts.push(`${result.removed} removed`);
      toast.success(parts.length > 0 ? `Sync complete: ${parts.join(', ')}` : 'No changes applied');
      queryClient.invalidateQueries({ queryKey: queryKeys.indexers() });
      setPreviewItems(null);
    },
    onError: (err) => {
      toast.error(`Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    },
  });

  const handleToggleSelection = useCallback((prowlarrId: number) => {
    setSelections(prev => ({ ...prev, [prowlarrId]: !prev[prowlarrId] }));
  }, []);

  const handleSaveAndPreview = useCallback(async () => {
    await saveMutation.mutateAsync();
    previewMutation.mutate();
  }, [saveMutation, previewMutation]);

  const hasSelections = previewItems?.some(
    item => item.action !== 'unchanged' && selections[item.prowlarrId],
  );

  const testIcon = testMutation.isPending ? (
    <LoadingSpinner className="w-3.5 h-3.5" />
  ) : testMutation.isSuccess && testMutation.data.success ? (
    <CheckIcon className="w-3.5 h-3.5 text-emerald-400" />
  ) : testMutation.isSuccess && !testMutation.data.success ? (
    <AlertCircleIcon className="w-3.5 h-3.5 text-red-400" />
  ) : null;

  return (
    <div className="glass-card rounded-2xl overflow-hidden animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center justify-between p-5 border-b border-border/50">
        <div>
          <h3 className="font-display text-lg font-semibold">Import from Prowlarr</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Connect to Prowlarr and import indexers as proxy entries
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-muted/80 transition-colors"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-5">
        {/* Connection */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">Prowlarr URL</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setTestPassed(false); }}
                placeholder="http://localhost:9696"
                className="flex-1 px-3 py-2 bg-background border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
              <button
                onClick={() => testMutation.mutate()}
                disabled={!url || !apiKey || testMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl border border-border/50 hover:bg-muted/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {testIcon}
                Test
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">API Key</label>
            <input
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
                        ? 'bg-primary/15 text-primary border-primary/20'
                        : 'bg-background text-muted-foreground hover:text-foreground hover:bg-muted/30'
                    } ${mode === 'addOnly' ? 'border-r border-border/50' : ''}`}
                  >
                    {mode === 'addOnly' ? 'Add Only' : 'Full Sync'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                {syncMode === 'addOnly'
                  ? 'Import new indexers, never update or remove existing'
                  : 'Add, update, and remove to match Prowlarr state'}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">Category Filter</label>
              <input
                type="text"
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
                placeholder="3030"
                className="w-full px-3 py-2 bg-background border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                Comma-separated IDs. 3030 = Audiobook.{' '}
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
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1 border-t border-border/30">
          <button
            onClick={handleSaveAndPreview}
            disabled={!url || !apiKey || !testPassed || saveMutation.isPending || previewMutation.isPending}
            title={!testPassed ? 'Test connection before previewing' : undefined}
            className="flex items-center gap-2 px-4 py-2.5 mt-4 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {(saveMutation.isPending || previewMutation.isPending) && (
              <LoadingSpinner className="w-4 h-4" />
            )}
            {isConfigured ? 'Re-sync Preview' : 'Save & Preview'}
          </button>

          {isConfigured && !previewItems && testPassed && (
            <button
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              className="flex items-center gap-2 px-4 py-2.5 mt-4 text-sm font-medium rounded-xl border border-border/50 hover:bg-muted/50 transition-all disabled:opacity-50"
            >
              <RefreshIcon className="w-4 h-4" />
              Preview Only
            </button>
          )}
        </div>

        {/* Preview Table */}
        {previewItems && (
          <div className="space-y-3 animate-fade-in-up">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">
                Preview
                <span className="ml-1.5 text-muted-foreground">
                  ({previewItems.filter(i => i.action !== 'unchanged').length} changes)
                </span>
              </h4>
              {previewItems.some(i => i.action === 'removed') && (
                <span className="flex items-center gap-1.5 text-xs text-amber-400">
                  <AlertCircleIcon className="w-3.5 h-3.5" />
                  Removed indexers will be deleted
                </span>
              )}
            </div>

            <div className="border border-border/30 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 text-muted-foreground text-xs uppercase tracking-wider">
                    <th className="py-2 px-4 text-left font-medium w-10"></th>
                    <th className="py-2 px-4 text-left font-medium">Indexer</th>
                    <th className="py-2 px-4 text-left font-medium">Type</th>
                    <th className="py-2 px-4 text-left font-medium">Status</th>
                    <th className="py-2 px-4 text-left font-medium hidden sm:table-cell">Changes</th>
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
                      <td className="py-2.5 px-4">
                        {item.action !== 'unchanged' && (
                          <input
                            type="checkbox"
                            checked={selections[item.prowlarrId] ?? false}
                            onChange={() => handleToggleSelection(item.prowlarrId)}
                            className="rounded border-border/50 bg-background text-primary focus:ring-primary/30 cursor-pointer"
                          />
                        )}
                      </td>
                      <td className="py-2.5 px-4 font-medium">{item.name}</td>
                      <td className="py-2.5 px-4">
                        <span className="text-xs font-mono text-muted-foreground uppercase">
                          {item.type}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <SyncActionBadge action={item.action} />
                      </td>
                      <td className="py-2.5 px-4 text-muted-foreground text-xs hidden sm:table-cell">
                        {item.changes?.join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => syncMutation.mutate()}
                disabled={!hasSelections || syncMutation.isPending}
                className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {syncMutation.isPending && <LoadingSpinner className="w-4 h-4" />}
                Apply Changes
              </button>
              <button
                onClick={() => setPreviewItems(null)}
                className="px-4 py-2.5 text-sm font-medium rounded-xl border border-border/50 hover:bg-muted/50 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
