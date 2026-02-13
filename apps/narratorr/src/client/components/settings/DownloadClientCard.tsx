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

const defaultValues: CreateDownloadClientFormData = {
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
};

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
    formState: { errors },
  } = useForm<CreateDownloadClientFormData>({
    resolver: zodResolver(createDownloadClientFormSchema),
    defaultValues: client
      ? {
          name: client.name,
          type: client.type as CreateDownloadClientFormData['type'],
          enabled: client.enabled,
          priority: client.priority,
          settings: {
            host: (client.settings as { host?: string }).host || '',
            port: (client.settings as { port?: number }).port || 8080,
            username: (client.settings as { username?: string }).username || '',
            password: (client.settings as { password?: string }).password || '',
            useSsl: (client.settings as { useSsl?: boolean }).useSsl || false,
          },
        }
      : defaultValues,
  });

  useEffect(() => {
    if (mode === 'edit' && client) {
      reset({
        name: client.name,
        type: client.type as CreateDownloadClientFormData['type'],
        enabled: client.enabled,
        priority: client.priority,
        settings: {
          host: (client.settings as { host?: string }).host || '',
          port: (client.settings as { port?: number }).port || 8080,
          username: (client.settings as { username?: string }).username || '',
          password: (client.settings as { password?: string }).password || '',
          useSsl: (client.settings as { useSsl?: boolean }).useSsl || false,
        },
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, client, reset]);

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
                {(client.settings as { host?: string; port?: number }).host}:
                {(client.settings as { host?: string; port?: number }).port}
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
              <p className="text-sm text-muted-foreground mt-1">Lower values are preferred first (1–100)</p>
            </div>
          </>
        )}

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
        <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
      )}

      <div className="flex items-center gap-3">
        <TestButton testing={!!testingForm} onClick={handleSubmit(onFormTest)} variant="form" />
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
