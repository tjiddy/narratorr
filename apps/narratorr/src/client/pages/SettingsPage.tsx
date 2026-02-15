import { useState, useEffect, useRef, useMemo } from 'react';
import { NavLink, Routes, Route, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api, type Indexer, type DownloadClient, type Notifier } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { IndexerCard } from '@/components/settings/IndexerCard';
import { DownloadClientCard } from '@/components/settings/DownloadClientCard';
import { NotifierCard } from '@/components/settings/NotifierCard';
import {
  LoadingSpinner,
  SettingsIcon,
  FolderIcon,
  SearchIcon,
  ServerIcon,
  PlusIcon,
  XIcon,
  CheckIcon,
  TerminalIcon,
  PackageIcon,
  BellIcon,
} from '@/components/icons';
import { useConnectionTest } from '@/hooks/useConnectionTest';
import { renderTemplate, ALLOWED_TOKENS } from '@narratorr/core/utils';
import {
  updateSettingsFormSchema,
  logLevelSchema,
  type CreateIndexerFormData,
  type CreateDownloadClientFormData,
  type CreateNotifierFormData,
  type UpdateSettingsFormData,
} from '../../shared/schemas.js';

const navItems = [
  { to: '/settings', label: 'General', icon: SettingsIcon, end: true },
  { to: '/settings/indexers', label: 'Indexers', icon: SearchIcon },
  { to: '/settings/download-clients', label: 'Download Clients', icon: ServerIcon },
  { to: '/settings/notifications', label: 'Notifications', icon: BellIcon },
];

export function SettingsPage() {
  const location = useLocation();

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
          Settings
        </h1>
        <p className="text-muted-foreground mt-2">
          Configure your Narratorr installation
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Navigation Sidebar */}
        <nav className="lg:w-56 shrink-0 animate-fade-in-up stagger-1">
          <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
            {navItems.map((item) => {
              const isActive = item.end
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to);
              const Icon = item.icon;

              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={`
                    flex items-center gap-3 px-4 py-3 rounded-xl whitespace-nowrap
                    transition-all duration-200
                    ${isActive
                      ? 'bg-primary text-primary-foreground shadow-glow'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }
                  `}
                >
                  <Icon className="w-5 h-5" />
                  <span className="font-medium">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 animate-fade-in-up stagger-2">
          <Routes>
            <Route index element={<GeneralSettings />} />
            <Route path="indexers" element={<IndexersSettings />} />
            <Route path="download-clients" element={<DownloadClientsSettings />} />
            <Route path="notifications" element={<NotificationsSettings />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const folderFormatRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<UpdateSettingsFormData>({
    resolver: zodResolver(updateSettingsFormSchema),
    defaultValues: {
      library: {
        path: '',
        folderFormat: '{author}/{title}',
      },
      search: {
        enabled: false,
        intervalMinutes: 360,
        autoGrab: false,
      },
      import: {
        deleteAfterImport: false,
        minSeedTime: 60,
      },
      general: {
        logLevel: 'info' as const,
      },
    },
  });

  // Reset form when settings are loaded
  useEffect(() => {
    if (settings) {
      reset({
        library: {
          path: settings.library.path,
          folderFormat: settings.library.folderFormat,
        },
        search: {
          enabled: settings.search?.enabled ?? false,
          intervalMinutes: settings.search?.intervalMinutes ?? 360,
          autoGrab: settings.search?.autoGrab ?? false,
        },
        import: {
          deleteAfterImport: settings.import?.deleteAfterImport ?? false,
          minSeedTime: settings.import?.minSeedTime ?? 60,
        },
        general: {
          logLevel: settings.general?.logLevel || 'info',
        },
      });
    }
  }, [settings, reset]);

  const mutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved successfully');
    },
    onError: () => {
      toast.error('Failed to save settings');
    },
  });

  const folderFormat = watch('library.folderFormat');

  const previewPath = useMemo(() => {
    if (!folderFormat) return '';
    return renderTemplate(folderFormat, {
      author: 'Brandon Sanderson',
      title: 'The Way of Kings',
      series: 'The Stormlight Archive',
      seriesPosition: 1,
      year: '2010',
      narrator: 'Michael Kramer, Kate Reading',
    });
  }, [folderFormat]);

  const hasTitleToken = folderFormat ? /\{title(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;
  const hasAuthorToken = folderFormat ? /\{author(?::\d+)?(?:\?[^}]*)?\}/.test(folderFormat) : true;

  const insertToken = (token: string) => {
    const input = folderFormatRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const newValue = `${before}{${token}}${after}`;
    setValue('library.folderFormat', newValue, { shouldDirty: true, shouldValidate: true });
    // Restore cursor position after the inserted token
    requestAnimationFrame(() => {
      const pos = start + token.length + 2; // +2 for { }
      input.setSelectionRange(pos, pos);
      input.focus();
    });
  };

  const onSubmit = (data: UpdateSettingsFormData) => {
    mutation.mutate(data);
  };

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <FolderIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Library</h2>
            <p className="text-sm text-muted-foreground">Configure where audiobooks are stored</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">Library Path</label>
            <input
              type="text"
              {...register('library.path')}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.library?.path ? 'border-destructive' : 'border-border'
              }`}
              placeholder="/audiobooks"
            />
            {errors.library?.path && (
              <p className="text-sm text-destructive mt-1">{errors.library.path.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              The root folder where imported audiobooks will be stored
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Folder Format</label>
            <input
              type="text"
              {...(() => {
                const { ref: rhfRef, ...rest } = register('library.folderFormat');
                return {
                  ...rest,
                  ref: (el: HTMLInputElement | null) => {
                    rhfRef(el);
                    folderFormatRef.current = el;
                  },
                };
              })()}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
                errors.library?.folderFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author}/{title}"
            />
            {errors.library?.folderFormat && (
              <p className="text-sm text-destructive mt-1">{errors.library.folderFormat.message}</p>
            )}

            {/* Token chips */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {ALLOWED_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => insertToken(token)}
                  className="px-2 py-1 bg-muted hover:bg-muted/80 text-xs font-mono rounded-md transition-colors cursor-pointer"
                >
                  {`{${token}}`}
                </button>
              ))}
            </div>

            {/* Validation feedback */}
            {!hasTitleToken && (
              <p className="text-sm text-destructive mt-2">
                Template must include {'{title}'}
              </p>
            )}
            {hasTitleToken && !hasAuthorToken && (
              <p className="text-sm text-amber-500 mt-2">
                Consider including {'{author}'} for better organization
              </p>
            )}

            {/* Live preview */}
            {folderFormat && (
              <div className="mt-3 p-3 bg-muted/50 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground mb-1">Preview</p>
                <p className="text-sm font-mono break-all">{previewPath || <span className="text-muted-foreground italic">Empty path</span>}</p>
              </div>
            )}

            <p className="text-sm text-muted-foreground mt-2">
              Use conditional blocks like <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{series? - }'}</code> to add separators only when a value exists.
              Use <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{seriesPosition:00}'}</code> for zero-padding.
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <SearchIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Search</h2>
            <p className="text-sm text-muted-foreground">Automatic searching for wanted books</p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Enable Scheduled Search</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Periodically search indexers for books in your wanted list
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                {...register('search.enabled')}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Search Interval (minutes)</label>
            <input
              type="number"
              {...register('search.intervalMinutes', { valueAsNumber: true })}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.search?.intervalMinutes ? 'border-destructive' : 'border-border'
              }`}
              min={5}
              max={1440}
              placeholder="360"
            />
            {errors.search?.intervalMinutes && (
              <p className="text-sm text-destructive mt-1">{errors.search.intervalMinutes.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              How often to search for new releases (5–1440 minutes)
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Auto-Grab Best Result</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Automatically grab the best result (most seeders) when a match is found
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                {...register('search.autoGrab')}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <PackageIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Import</h2>
            <p className="text-sm text-muted-foreground">Configure post-download import behavior</p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium">Delete After Import</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Remove torrent from download client after files are imported
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                {...register('import.deleteAfterImport')}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Minimum Seed Time (minutes)</label>
            <input
              type="number"
              {...register('import.minSeedTime', { valueAsNumber: true })}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.import?.minSeedTime ? 'border-destructive' : 'border-border'
              }`}
              min={0}
              placeholder="60"
            />
            {errors.import?.minSeedTime && (
              <p className="text-sm text-destructive mt-1">{errors.import.minSeedTime.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              How long to seed before removing the torrent (only applies when delete after import is enabled)
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-xl">
            <TerminalIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Logging</h2>
            <p className="text-sm text-muted-foreground">Control server log verbosity</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-2">Log Level</label>
            <select
              {...register('general.logLevel')}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            >
              {logLevelSchema.options.map((level) => (
                <option key={level} value={level}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground mt-2">
              Set to Debug for detailed diagnostic output, or Error to reduce noise
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={mutation.isPending || !isDirty}
          className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {mutation.isPending ? (
            <>
              <LoadingSpinner className="w-4 h-4" />
              Saving...
            </>
          ) : (
            <>
              <CheckIcon className="w-4 h-4" />
              Save Changes
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function IndexersSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Indexer | null>(null);

  const {
    testingId, testResult, testingForm, formTestResult,
    handleTest, handleFormTest, clearFormTestResult,
  } = useConnectionTest<CreateIndexerFormData>({
    testById: api.testIndexer,
    testByConfig: api.testIndexerConfig,
  });

  const { data: indexers = [], isLoading } = useQuery({
    queryKey: queryKeys.indexers(),
    queryFn: api.getIndexers,
  });

  const createMutation = useMutation({
    mutationFn: api.createIndexer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.indexers() });
      setShowForm(false);
      toast.success('Indexer added successfully');
    },
    onError: () => {
      toast.error('Failed to add indexer');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: CreateIndexerFormData }) =>
      api.updateIndexer(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.indexers() });
      setEditingId(null);
      toast.success('Indexer updated');
    },
    onError: () => {
      toast.error('Failed to update indexer');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteIndexer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.indexers() });
      toast.success('Indexer removed successfully');
    },
    onError: () => {
      toast.error('Failed to delete indexer');
    },
  });

  const handleToggleForm = () => {
    if (showForm) {
      clearFormTestResult();
    } else {
      setEditingId(null);
    }
    setShowForm(!showForm);
  };

  const handleEdit = (id: number) => {
    setShowForm(false);
    clearFormTestResult();
    setEditingId(id);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    clearFormTestResult();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <SearchIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Indexers</h2>
            <p className="text-sm text-muted-foreground">Manage audiobook search sources</p>
          </div>
        </div>
        <button
          onClick={handleToggleForm}
          className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
            showForm
              ? 'bg-muted text-muted-foreground hover:bg-muted/80'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          }`}
        >
          {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Indexer'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <IndexerCard
          mode="create"
          onSubmit={(data) => createMutation.mutate(data)}
          onFormTest={handleFormTest}
          isPending={createMutation.isPending}
          testingForm={testingForm}
          formTestResult={formTestResult}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : indexers.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <SearchIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No indexers configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add an indexer to start searching for audiobooks
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {indexers.map((indexer, index) => (
            <IndexerCard
              key={indexer.id}
              indexer={indexer}
              mode={editingId === indexer.id ? 'edit' : 'view'}
              onEdit={() => handleEdit(indexer.id)}
              onCancel={handleCancelEdit}
              onDelete={() => setDeleteTarget(indexer)}
              onSubmit={(data) => updateMutation.mutate({ id: indexer.id, data })}
              onFormTest={handleFormTest}
              onTest={handleTest}
              isPending={updateMutation.isPending}
              testingId={testingId}
              testResult={testResult}
              testingForm={testingForm}
              formTestResult={editingId === indexer.id ? formTestResult : null}
              animationDelay={`${index * 50}ms`}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Indexer"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function DownloadClientsSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DownloadClient | null>(null);

  const {
    testingId, testResult, testingForm, formTestResult,
    handleTest, handleFormTest, clearFormTestResult,
  } = useConnectionTest<CreateDownloadClientFormData>({
    testById: api.testClient,
    testByConfig: api.testClientConfig,
  });

  const { data: clients = [], isLoading } = useQuery({
    queryKey: queryKeys.downloadClients(),
    queryFn: api.getClients,
  });

  const createMutation = useMutation({
    mutationFn: api.createClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.downloadClients() });
      setShowForm(false);
      toast.success('Download client added successfully');
    },
    onError: () => {
      toast.error('Failed to add download client');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: CreateDownloadClientFormData }) =>
      api.updateClient(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.downloadClients() });
      setEditingId(null);
      toast.success('Download client updated');
    },
    onError: () => {
      toast.error('Failed to update download client');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.downloadClients() });
      toast.success('Download client removed successfully');
    },
    onError: () => {
      toast.error('Failed to delete download client');
    },
  });

  const handleToggleForm = () => {
    if (showForm) {
      clearFormTestResult();
    } else {
      setEditingId(null);
    }
    setShowForm(!showForm);
  };

  const handleEdit = (id: number) => {
    setShowForm(false);
    clearFormTestResult();
    setEditingId(id);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    clearFormTestResult();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <ServerIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Download Clients</h2>
            <p className="text-sm text-muted-foreground">Manage torrent clients</p>
          </div>
        </div>
        <button
          onClick={handleToggleForm}
          className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
            showForm
              ? 'bg-muted text-muted-foreground hover:bg-muted/80'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          }`}
        >
          {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Client'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <DownloadClientCard
          mode="create"
          onSubmit={(data) => createMutation.mutate(data)}
          onFormTest={handleFormTest}
          isPending={createMutation.isPending}
          testingForm={testingForm}
          formTestResult={formTestResult}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : clients.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <ServerIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No download clients configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add a download client to start grabbing audiobooks
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {clients.map((client, index) => (
            <DownloadClientCard
              key={client.id}
              client={client}
              mode={editingId === client.id ? 'edit' : 'view'}
              onEdit={() => handleEdit(client.id)}
              onCancel={handleCancelEdit}
              onDelete={() => setDeleteTarget(client)}
              onSubmit={(data) => updateMutation.mutate({ id: client.id, data })}
              onFormTest={handleFormTest}
              onTest={handleTest}
              isPending={updateMutation.isPending}
              testingId={testingId}
              testResult={testResult}
              testingForm={testingForm}
              formTestResult={editingId === client.id ? formTestResult : null}
              animationDelay={`${index * 50}ms`}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Download Client"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function NotificationsSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Notifier | null>(null);

  const {
    testingId, testResult, testingForm, formTestResult,
    handleTest, handleFormTest, clearFormTestResult,
  } = useConnectionTest<CreateNotifierFormData>({
    testById: api.testNotifier,
    testByConfig: api.testNotifierConfig,
  });

  const { data: notifiers = [], isLoading } = useQuery({
    queryKey: queryKeys.notifiers(),
    queryFn: api.getNotifiers,
  });

  const createMutation = useMutation({
    mutationFn: api.createNotifier,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifiers() });
      setShowForm(false);
      toast.success('Notifier added successfully');
    },
    onError: () => {
      toast.error('Failed to add notifier');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: CreateNotifierFormData }) =>
      api.updateNotifier(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifiers() });
      setEditingId(null);
      toast.success('Notifier updated');
    },
    onError: () => {
      toast.error('Failed to update notifier');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteNotifier,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifiers() });
      toast.success('Notifier removed successfully');
    },
    onError: () => {
      toast.error('Failed to delete notifier');
    },
  });

  const handleToggleForm = () => {
    if (showForm) {
      clearFormTestResult();
    } else {
      setEditingId(null);
    }
    setShowForm(!showForm);
  };

  const handleEdit = (id: number) => {
    setShowForm(false);
    clearFormTestResult();
    setEditingId(id);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    clearFormTestResult();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <BellIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Notifications</h2>
            <p className="text-sm text-muted-foreground">Get notified on grabs, downloads, imports, and failures</p>
          </div>
        </div>
        <button
          onClick={handleToggleForm}
          className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
            showForm
              ? 'bg-muted text-muted-foreground hover:bg-muted/80'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          }`}
        >
          {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Notifier'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <NotifierCard
          mode="create"
          onSubmit={(data) => createMutation.mutate(data)}
          onFormTest={handleFormTest}
          isPending={createMutation.isPending}
          testingForm={testingForm}
          formTestResult={formTestResult}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : notifiers.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <BellIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No notifications configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add a notifier to get alerts on grabs, downloads, and imports
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifiers.map((notifier, index) => (
            <NotifierCard
              key={notifier.id}
              notifier={notifier}
              mode={editingId === notifier.id ? 'edit' : 'view'}
              onEdit={() => handleEdit(notifier.id)}
              onCancel={handleCancelEdit}
              onDelete={() => setDeleteTarget(notifier)}
              onSubmit={(data) => updateMutation.mutate({ id: notifier.id, data })}
              onFormTest={handleFormTest}
              onTest={handleTest}
              isPending={updateMutation.isPending}
              testingId={testingId}
              testResult={testResult}
              testingForm={testingForm}
              formTestResult={editingId === notifier.id ? formTestResult : null}
              animationDelay={`${index * 50}ms`}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Notifier"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
