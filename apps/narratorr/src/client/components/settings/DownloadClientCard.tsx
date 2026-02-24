import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DownloadClient, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { SettingsFormActions } from './SettingsFormActions';
import { DownloadClientFields } from './DownloadClientFields';
import {
  createDownloadClientFormSchema,
  downloadClientTypeSchema,
  type CreateDownloadClientFormData,
} from '../../../shared/schemas.js';

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
  qbittorrent: { host: '', port: 8080, username: '', password: '', useSsl: false, category: '' },
  transmission: { host: '', port: 9091, username: '', password: '', category: '' },
  sabnzbd: { host: '', port: 8080, apiKey: '', category: '' },
  nzbget: { host: '', port: 6789, username: '', password: '', category: '' },
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
    category: (s.category as string) || '',
  };
}

function viewSubtitle(client: DownloadClient): string {
  const s = client.settings as Record<string, unknown>;
  const host = (s.host as string) || '';
  const port = (s.port as number) || '';
  return host && port ? `${host}:${port}` : client.type;
}

const defaultValues: CreateDownloadClientFormData = {
  name: '',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: { host: '', port: 8080, username: '', password: '', useSsl: false, category: '' },
};

export function DownloadClientCard(props: DownloadClientCardProps) {
  const {
    client, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest,
    onTest, isPending, testingId, testResult, testingForm, formTestResult, animationDelay,
  } = props;
  const {
    register, handleSubmit, reset, watch, setValue,
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

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = watch('type');

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

  useEffect(() => {
    if (mode === 'create') {
      setValue('settings', defaultSettings[selectedType] || defaultSettings.qbittorrent);
    }
  }, [selectedType, mode, setValue]);

  const isImplemented = IMPLEMENTED_TYPES.includes(selectedType);

  if (mode === 'view' && client) {
    return (
      <SettingsCardShell
        name={client.name}
        subtitle={viewSubtitle(client)}
        enabled={client.enabled}
        itemId={client.id}
        onEdit={onEdit}
        onTest={onTest}
        onDelete={onDelete}
        testingId={testingId}
        testResult={testResult}
        testDisabled={!IMPLEMENTED_TYPES.includes(client.type)}
        testDisabledTitle={!IMPLEMENTED_TYPES.includes(client.type) ? 'Testing available for implemented adapter types' : undefined}
        animationDelay={animationDelay}
      />
    );
  }

  const isEdit = mode === 'edit';
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Download Client' : 'Add Download Client'}
      </h3>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="clientName" className="block text-sm font-medium mb-2">Name</label>
          <input
            id="clientName"
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
          <label htmlFor="clientType" className="block text-sm font-medium mb-2">Type</label>
          <select
            id="clientType"
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
              <label htmlFor="clientPriority" className="block text-sm font-medium mb-2">Priority</label>
              <input
                id="clientPriority"
                type="number"
                {...register('priority', { valueAsNumber: true })}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
              <p className="text-sm text-muted-foreground mt-1">Lower values are preferred first (1-100)</p>
            </div>
          </>
        )}
        <DownloadClientFields selectedType={selectedType} register={register} errors={errors} />
      </div>

      {!isImplemented && (
        <p className="text-sm text-amber-500">
          Adapter not yet implemented. Config will be saved for when the adapter is available.
        </p>
      )}

      {formTestResult && (
        <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
      )}

      <SettingsFormActions
        isEdit={isEdit}
        isPending={isPending}
        testingForm={testingForm}
        onFormTest={handleSubmit(onFormTest)}
        onCancel={onCancel}
        entityLabel="Client"
        testDisabled={!isImplemented}
        testDisabledTitle={!isImplemented ? 'Testing available for implemented adapter types' : undefined}
      />
    </form>
  );
}
