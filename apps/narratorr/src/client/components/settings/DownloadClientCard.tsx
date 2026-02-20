import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DownloadClient, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { TestButton } from '@/components/TestButton';
import {
  LoadingSpinner,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  CheckIcon,
  XIcon,
} from '@/components/icons';
import {
  createDownloadClientFormSchema,
  downloadClientTypeSchema,
  type CreateDownloadClientFormData,
} from '../../../shared/schemas.js';

interface IdTestResult extends TestResult {
  id: number;
}

interface DownloadClientCardProps {
  client?: DownloadClient;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: CreateDownloadClientFormData) => void;
  onFormTest: (data: CreateDownloadClientFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
}

const IMPLEMENTED_TYPES = ['qbittorrent', 'transmission', 'sabnzbd', 'nzbget'];

const TYPE_LABELS: Record<string, string> = {
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
};

const defaultSettings: Record<string, CreateDownloadClientFormData['settings']> = {
  qbittorrent: { host: '', port: 8080, username: '', password: '', useSsl: false },
  transmission: { host: '', port: 9091, username: '', password: '' },
  sabnzbd: { host: '', port: 8080, apiKey: '' },
  nzbget: { host: '', port: 6789, username: '', password: '' },
};

function settingsFromClient(client: DownloadClient): CreateDownloadClientFormData['settings'] {
  const s = client.settings as Record<string, unknown>;
  return {
    host: (s.host as string) || '',
    port: (s.port as number) || 8080,
    username: (s.username as string) || '',
    password: (s.password as string) || '',
    useSsl: (s.useSsl as boolean) || false,
    apiKey: (s.apiKey as string) || '',
  };
}

function viewSubtitle(client: DownloadClient): string {
  const s = client.settings as Record<string, unknown>;
  const host = (s.host as string) || '';
  const port = (s.port as number) || '';
  return host && port ? `${host}:${port}` : client.type;
}

// Which fields to show per type
const TYPE_FIELDS: Record<string, { username: boolean; password: boolean; useSsl: boolean; apiKey: boolean }> = {
  qbittorrent: { username: true, password: true, useSsl: true, apiKey: false },
  transmission: { username: true, password: true, useSsl: true, apiKey: false },
  sabnzbd: { username: false, password: false, useSsl: true, apiKey: true },
  nzbget: { username: true, password: true, useSsl: true, apiKey: false },
};

const defaultValues: CreateDownloadClientFormData = {
  name: '',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: { host: '', port: 8080, username: '', password: '', useSsl: false },
};

// eslint-disable-next-line max-lines-per-function, complexity
export function DownloadClientCard({
  client,
  mode,
  onEdit,
  onCancel,
  onDelete,
  onSubmit,
  onFormTest,
  onTest,
  isPending,
  testingId,
  testResult,
  testingForm,
  formTestResult,
  animationDelay,
}: DownloadClientCardProps) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateDownloadClientFormData>({
    resolver: zodResolver(createDownloadClientFormSchema),
    defaultValues: client
      ? {
          name: client.name,
          type: client.type as CreateDownloadClientFormData['type'],
          enabled: client.enabled,
          priority: client.priority,
          settings: settingsFromClient(client),
        }
      : defaultValues,
  });

  const selectedType = watch('type');
  const fields = TYPE_FIELDS[selectedType] || TYPE_FIELDS.qbittorrent;

  useEffect(() => {
    if (mode === 'edit' && client) {
      reset({
        name: client.name,
        type: client.type as CreateDownloadClientFormData['type'],
        enabled: client.enabled,
        priority: client.priority,
        settings: settingsFromClient(client),
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, client, reset]);

  // Reset settings when type changes (only in create mode)
  useEffect(() => {
    if (mode === 'create') {
      setValue('settings', defaultSettings[selectedType] || defaultSettings.qbittorrent);
    }
  }, [selectedType, mode, setValue]);

  const isImplemented = IMPLEMENTED_TYPES.includes(selectedType);

  // View mode
  if (mode === 'view' && client) {
    return (
      <div
        className="glass-card rounded-2xl p-5 animate-fade-in-up"
        style={animationDelay ? { animationDelay } : undefined}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className={`w-3 h-3 rounded-full shrink-0 ${client.enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
            <div className="min-w-0">
              <h3 className="font-display font-semibold truncate">{client.name}</h3>
              <p className="text-sm text-muted-foreground truncate">
                {viewSubtitle(client)}
              </p>
              {testResult?.id === client.id && (
                <TestResultMessage
                  success={testResult.success}
                  message={testResult.message}
                  successText="Connected!"
                  failureText="Failed"
                />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onEdit}
              aria-label={`Edit ${client.name}`}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
            >
              <PencilIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Edit</span>
            </button>
            <TestButton
              testing={testingId === client.id}
              onClick={() => onTest?.(client.id)}
              variant="inline"
              disabled={!IMPLEMENTED_TYPES.includes(client.type)}
              title={!IMPLEMENTED_TYPES.includes(client.type) ? 'Testing available for implemented adapter types' : undefined}
            />
            <button
              onClick={onDelete}
              aria-label={`Delete ${client.name}`}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-destructive border border-destructive/30 rounded-xl hover:bg-destructive hover:text-destructive-foreground transition-all focus-ring"
            >
              <TrashIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Edit / Create form mode
  const isEdit = mode === 'edit';
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Download Client' : 'Add Download Client'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
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
          <label className="block text-sm font-medium mb-2">Type</label>
          <select
            {...register('type')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          >
            {downloadClientTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] || t}
              </option>
            ))}
          </select>
        </div>

        {isEdit && (
          <>
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  {...register('enabled')}
                  className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
                />
                <span className="text-sm font-medium">Enabled</span>
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Priority</label>
              <input
                type="number"
                {...register('priority', { valueAsNumber: true })}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
              <p className="text-sm text-muted-foreground mt-1">Lower values are preferred first (1-100)</p>
            </div>
          </>
        )}

        {/* Host + Port — all types need these */}
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
          {errors.settings?.host ? (
            <p className="text-sm text-destructive mt-1">{errors.settings.host.message}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">Hostname or IP without protocol</p>
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

        {/* Username + Password — qbittorrent, transmission, nzbget */}
        {fields.username && (
          <div>
            <label className="block text-sm font-medium mb-2">Username</label>
            <input
              type="text"
              {...register('settings.username')}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              placeholder="admin"
            />
          </div>
        )}
        {fields.password && (
          <div>
            <label className="block text-sm font-medium mb-2">Password</label>
            <input
              type="password"
              {...register('settings.password')}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            />
          </div>
        )}

        {/* API Key — sabnzbd */}
        {fields.apiKey && (
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium mb-2">API Key</label>
            <input
              type="password"
              {...register('settings.apiKey')}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                errors.settings?.apiKey ? 'border-destructive' : 'border-border'
              }`}
            />
            {errors.settings?.apiKey && (
              <p className="text-sm text-destructive mt-1">{errors.settings.apiKey.message}</p>
            )}
          </div>
        )}

        {/* SSL toggle — qbittorrent only */}
        {fields.useSsl && (
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
        )}
      </div>

      {!isImplemented && (
        <p className="text-sm text-amber-500">
          Adapter not yet implemented. Config will be saved for when the adapter is available.
        </p>
      )}

      {formTestResult && (
        <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
      )}

      <div className="flex items-center gap-3">
        <TestButton
          testing={!!testingForm}
          onClick={handleSubmit(onFormTest)}
          variant="form"
          disabled={!isImplemented}
          title={!isImplemented ? 'Testing available for implemented adapter types' : undefined}
        />
        {isEdit && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
          >
            <XIcon className="w-4 h-4" />
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {isPending ? (
            <>
              <LoadingSpinner className="w-4 h-4" />
              {isEdit ? 'Saving...' : 'Adding...'}
            </>
          ) : (
            <>
              {isEdit ? <CheckIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
              {isEdit ? 'Save Changes' : 'Add Client'}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
