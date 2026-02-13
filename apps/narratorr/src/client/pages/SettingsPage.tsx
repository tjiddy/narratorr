import { useState, useEffect } from 'react';
import { NavLink, Routes, Route, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { api, type Indexer, type DownloadClient } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';
import {
  createIndexerFormSchema,
  createDownloadClientFormSchema,
  updateSettingsFormSchema,
  logLevelSchema,
  type CreateIndexerFormData,
  type CreateDownloadClientFormData,
  type UpdateSettingsFormData,
} from '../../shared/schemas.js';

// Icons
function LoadingSpinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

function SettingsIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function FolderIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ServerIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  );
}

function PlusIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function XIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function TrashIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function ZapIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function AlertCircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  );
}

function TerminalIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

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
    queryKey: ['settings'],
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
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; success: boolean; message?: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Indexer | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [formTestResult, setFormTestResult] = useState<{ success: boolean; message?: string } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateIndexerFormData>({
    resolver: zodResolver(createIndexerFormSchema),
    defaultValues: {
      name: '',
      type: 'abb',
      enabled: true,
      priority: 50,
      settings: {
        hostname: '',
        pageLimit: 2,
      },
    },
  });

  const { data: indexers = [], isLoading } = useQuery({
    queryKey: ['indexers'],
    queryFn: api.getIndexers,
  });

  const createMutation = useMutation({
    mutationFn: api.createIndexer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['indexers'] });
      setShowForm(false);
      reset();
      toast.success('Indexer added successfully');
    },
    onError: () => {
      toast.error('Failed to add indexer');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteIndexer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['indexers'] });
      toast.success('Indexer removed successfully');
      setDeleteTarget(null);
    },
  });

  const handleTest = async (id: number) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await api.testIndexer(id);
      setTestResult({ id, ...result });
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setTestResult({ id, success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingId(null);
  };

  const onSubmit = (data: CreateIndexerFormData) => {
    createMutation.mutate(data);
  };

  const handleFormTest = async (data: CreateIndexerFormData) => {
    setTestingForm(true);
    setFormTestResult(null);
    try {
      const result = await api.testIndexerConfig(data);
      setFormTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setFormTestResult({ success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingForm(false);
  };

  const handleToggleForm = () => {
    if (showForm) {
      reset();
      setFormTestResult(null);
    }
    setShowForm(!showForm);
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
        <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
          <h3 className="font-display text-lg font-semibold">Add New Indexer</h3>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                {...register('name')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.name ? 'border-destructive' : 'border-border'
                }`}
                placeholder="AudioBookBay"
              />
              {errors.name && (
                <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Hostname</label>
              <input
                type="text"
                {...register('settings.hostname')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.hostname ? 'border-destructive' : 'border-border'
                }`}
                placeholder="audiobookbay.lu"
              />
              {errors.settings?.hostname && (
                <p className="text-sm text-destructive mt-1">{errors.settings.hostname.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Page Limit</label>
              <input
                type="number"
                {...register('settings.pageLimit', { valueAsNumber: true })}
                min={1}
                max={10}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.pageLimit ? 'border-destructive' : 'border-border'
                }`}
              />
              {errors.settings?.pageLimit && (
                <p className="text-sm text-destructive mt-1">{errors.settings.pageLimit.message}</p>
              )}
            </div>
          </div>

          {formTestResult && (
            <p className={`text-sm flex items-center gap-1.5 ${formTestResult.success ? 'text-success' : 'text-destructive'}`}>
              {formTestResult.success ? <CheckIcon className="w-3.5 h-3.5" /> : <AlertCircleIcon className="w-3.5 h-3.5" />}
              {formTestResult.message || (formTestResult.success ? 'Connection successful!' : 'Connection failed')}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSubmit(handleFormTest)}
              disabled={testingForm}
              className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 transition-all focus-ring"
            >
              {testingForm ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  Testing...
                </>
              ) : (
                <>
                  <ZapIcon className="w-4 h-4" />
                  Test
                </>
              )}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
            >
              {createMutation.isPending ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  Adding...
                </>
              ) : (
                <>
                  <PlusIcon className="w-4 h-4" />
                  Add Indexer
                </>
              )}
            </button>
          </div>
        </form>
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
            <div
              key={indexer.id}
              className="glass-card rounded-2xl p-5 animate-fade-in-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className={`w-3 h-3 rounded-full shrink-0 ${indexer.enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold truncate">{indexer.name}</h3>
                    <p className="text-sm text-muted-foreground truncate">
                      {(indexer.settings as { hostname?: string }).hostname || indexer.type}
                    </p>
                    {testResult?.id === indexer.id && (
                      <p className={`text-sm mt-1 flex items-center gap-1.5 ${testResult.success ? 'text-success' : 'text-destructive'}`}>
                        {testResult.success ? <CheckIcon className="w-3.5 h-3.5" /> : <AlertCircleIcon className="w-3.5 h-3.5" />}
                        {testResult.message || (testResult.success ? 'Connected!' : 'Failed')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleTest(indexer.id)}
                    disabled={testingId === indexer.id}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 transition-all focus-ring"
                  >
                    {testingId === indexer.id ? (
                      <LoadingSpinner className="w-4 h-4" />
                    ) : (
                      <ZapIcon className="w-4 h-4" />
                    )}
                    <span className="hidden sm:inline">Test</span>
                  </button>
                  <button
                    onClick={() => setDeleteTarget(indexer)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-destructive border border-destructive/30 rounded-xl hover:bg-destructive hover:text-destructive-foreground transition-all focus-ring"
                  >
                    <TrashIcon className="w-4 h-4" />
                    <span className="hidden sm:inline">Delete</span>
                  </button>
                </div>
              </div>
            </div>
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
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; success: boolean; message?: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DownloadClient | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [formTestResult, setFormTestResult] = useState<{ success: boolean; message?: string } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateDownloadClientFormData>({
    resolver: zodResolver(createDownloadClientFormSchema),
    defaultValues: {
      name: '',
      type: 'qbittorrent',
      enabled: true,
      priority: 50,
      settings: {
        host: '',
        port: 8080,
        username: '',
        password: '',
        useSsl: false,
      },
    },
  });

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['download-clients'],
    queryFn: api.getClients,
  });

  const createMutation = useMutation({
    mutationFn: api.createClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download-clients'] });
      setShowForm(false);
      reset();
      toast.success('Download client added successfully');
    },
    onError: () => {
      toast.error('Failed to add download client');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download-clients'] });
      toast.success('Download client removed successfully');
      setDeleteTarget(null);
    },
  });

  const handleTest = async (id: number) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await api.testClient(id);
      setTestResult({ id, ...result });
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setTestResult({ id, success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingId(null);
  };

  const onSubmit = (data: CreateDownloadClientFormData) => {
    createMutation.mutate(data);
  };

  const handleFormTest = async (data: CreateDownloadClientFormData) => {
    setTestingForm(true);
    setFormTestResult(null);
    try {
      const result = await api.testClientConfig(data);
      setFormTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.message || 'Connection failed');
      }
    } catch {
      setFormTestResult({ success: false, message: 'Test failed' });
      toast.error('Connection test failed');
    }
    setTestingForm(false);
  };

  const handleToggleForm = () => {
    if (showForm) {
      reset();
      setFormTestResult(null);
    }
    setShowForm(!showForm);
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
        <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
          <h3 className="font-display text-lg font-semibold">Add Download Client</h3>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-2">Name</label>
              <input
                type="text"
                {...register('name')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.name ? 'border-destructive' : 'border-border'
                }`}
                placeholder="qBittorrent"
              />
              {errors.name && (
                <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Host</label>
              <input
                type="text"
                {...register('settings.host')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.host ? 'border-destructive' : 'border-border'
                }`}
                placeholder="localhost"
              />
              {errors.settings?.host && (
                <p className="text-sm text-destructive mt-1">{errors.settings.host.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Port</label>
              <input
                type="number"
                {...register('settings.port', { valueAsNumber: true })}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.port ? 'border-destructive' : 'border-border'
                }`}
              />
              {errors.settings?.port && (
                <p className="text-sm text-destructive mt-1">{errors.settings.port.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Username</label>
              <input
                type="text"
                {...register('settings.username')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.username ? 'border-destructive' : 'border-border'
                }`}
                placeholder="admin"
              />
              {errors.settings?.username && (
                <p className="text-sm text-destructive mt-1">{errors.settings.username.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Password</label>
              <input
                type="password"
                {...register('settings.password')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.password ? 'border-destructive' : 'border-border'
                }`}
              />
              {errors.settings?.password && (
                <p className="text-sm text-destructive mt-1">{errors.settings.password.message}</p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  {...register('settings.useSsl')}
                  className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
                />
                <span className="text-sm font-medium">Use SSL/HTTPS</span>
              </label>
            </div>
          </div>

          {formTestResult && (
            <p className={`text-sm flex items-center gap-1.5 ${formTestResult.success ? 'text-success' : 'text-destructive'}`}>
              {formTestResult.success ? <CheckIcon className="w-3.5 h-3.5" /> : <AlertCircleIcon className="w-3.5 h-3.5" />}
              {formTestResult.message || (formTestResult.success ? 'Connection successful!' : 'Connection failed')}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSubmit(handleFormTest)}
              disabled={testingForm}
              className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 transition-all focus-ring"
            >
              {testingForm ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  Testing...
                </>
              ) : (
                <>
                  <ZapIcon className="w-4 h-4" />
                  Test
                </>
              )}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
            >
              {createMutation.isPending ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  Adding...
                </>
              ) : (
                <>
                  <PlusIcon className="w-4 h-4" />
                  Add Client
                </>
              )}
            </button>
          </div>
        </form>
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
            <div
              key={client.id}
              className="glass-card rounded-2xl p-5 animate-fade-in-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 min-w-0">
                  <div className={`w-3 h-3 rounded-full shrink-0 ${client.enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold truncate">{client.name}</h3>
                    <p className="text-sm text-muted-foreground truncate">
                      {(client.settings as { host?: string; port?: number }).host}:
                      {(client.settings as { host?: string; port?: number }).port}
                    </p>
                    {testResult?.id === client.id && (
                      <p className={`text-sm mt-1 flex items-center gap-1.5 ${testResult.success ? 'text-success' : 'text-destructive'}`}>
                        {testResult.success ? <CheckIcon className="w-3.5 h-3.5" /> : <AlertCircleIcon className="w-3.5 h-3.5" />}
                        {testResult.message || (testResult.success ? 'Connected!' : 'Failed')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleTest(client.id)}
                    disabled={testingId === client.id}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted disabled:opacity-50 transition-all focus-ring"
                  >
                    {testingId === client.id ? (
                      <LoadingSpinner className="w-4 h-4" />
                    ) : (
                      <ZapIcon className="w-4 h-4" />
                    )}
                    <span className="hidden sm:inline">Test</span>
                  </button>
                  <button
                    onClick={() => setDeleteTarget(client)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-destructive border border-destructive/30 rounded-xl hover:bg-destructive hover:text-destructive-foreground transition-all focus-ring"
                  >
                    <TrashIcon className="w-4 h-4" />
                    <span className="hidden sm:inline">Delete</span>
                  </button>
                </div>
              </div>
            </div>
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
