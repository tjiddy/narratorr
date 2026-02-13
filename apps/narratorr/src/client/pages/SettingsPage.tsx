import { useState, useEffect } from 'react';
import { NavLink, Routes, Route, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api, type Indexer, type DownloadClient } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { IndexerCard } from '@/components/settings/IndexerCard';
import { DownloadClientCard } from '@/components/settings/DownloadClientCard';
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
} from '@/components/icons';
import { useConnectionTest } from '@/hooks/useConnectionTest';
import {
  updateSettingsFormSchema,
  logLevelSchema,
  type CreateIndexerFormData,
  type CreateDownloadClientFormData,
  type UpdateSettingsFormData,
} from '../../shared/schemas.js';

const navItems = [
  { to: '/settings', label: 'General', icon: SettingsIcon, end: true },
  { to: '/settings/indexers', label: 'Indexers', icon: SearchIcon },
  { to: '/settings/download-clients', label: 'Download Clients', icon: ServerIcon },
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

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<UpdateSettingsFormData>({
    resolver: zodResolver(updateSettingsFormSchema),
    defaultValues: {
      library: {
        path: '',
        folderFormat: '{author}/{title}',
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
              {...register('library.folderFormat')}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm ${
                errors.library?.folderFormat ? 'border-destructive' : 'border-border'
              }`}
              placeholder="{author}/{title}"
            />
            {errors.library?.folderFormat && (
              <p className="text-sm text-destructive mt-1">{errors.library.folderFormat.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              Available tokens: <code className="px-1.5 py-0.5 bg-muted rounded text-xs">{'{author}'}</code>, <code className="px-1.5 py-0.5 bg-muted rounded text-xs">{'{title}'}</code>
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
      queryClient.invalidateQueries({ queryKey: ['indexers'] });
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
      setDeleteTarget(null);
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
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
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
      queryClient.invalidateQueries({ queryKey: ['download-clients'] });
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
      setDeleteTarget(null);
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
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
