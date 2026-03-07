import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DownloadClient, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { SettingsFormActions } from './SettingsFormActions';
import { DownloadClientFields } from './DownloadClientFields';
import { BlackholeFields } from './BlackholeFields';
import { RemotePathMappingsSubsection } from './RemotePathMappingsSubsection';
import {
  createDownloadClientFormSchema,
  downloadClientTypeSchema,
  type CreateDownloadClientFormData,
} from '../../../shared/schemas.js';
import { DOWNLOAD_CLIENT_REGISTRY, settingsFromClient } from '../../../shared/download-client-registry.js';

const IMPLEMENTED_TYPES = Object.keys(DOWNLOAD_CLIENT_REGISTRY);

const defaultValues: CreateDownloadClientFormData = {
  name: '',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: DOWNLOAD_CLIENT_REGISTRY.qbittorrent.defaultSettings,
};

interface DownloadClientFormProps {
  client?: DownloadClient;
  mode: 'edit' | 'create';
  onCancel?: () => void;
  onSubmit: (data: CreateDownloadClientFormData) => void;
  onFormTest: (data: CreateDownloadClientFormData) => void;
  isPending?: boolean;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
}

export function DownloadClientForm({ client, mode, onCancel, onSubmit, onFormTest, isPending, testingForm, formTestResult }: DownloadClientFormProps) {
  const isEdit = mode === 'edit';
  const {
    register, handleSubmit, reset, watch, setValue, getValues,
    formState: { errors, isDirty },
  } = useForm<CreateDownloadClientFormData>({
    resolver: zodResolver(createDownloadClientFormSchema),
    defaultValues: client
      ? { name: client.name, type: client.type as CreateDownloadClientFormData['type'], enabled: client.enabled, priority: client.priority, settings: settingsFromClient(client) }
      : defaultValues,
  });

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = watch('type');

  useEffect(() => {
    if (isEdit && client) {
      reset({ name: client.name, type: client.type as CreateDownloadClientFormData['type'], enabled: client.enabled, priority: client.priority, settings: settingsFromClient(client) });
    } else if (!isEdit) {
      reset(defaultValues);
    }
  }, [isEdit, client, reset]);

  useEffect(() => {
    if (!isEdit) setValue('settings', DOWNLOAD_CLIENT_REGISTRY[selectedType]?.defaultSettings || DOWNLOAD_CLIENT_REGISTRY.qbittorrent.defaultSettings);
  }, [selectedType, isEdit, setValue]);

  const isImplemented = IMPLEMENTED_TYPES.includes(selectedType);
  const inputClass = 'w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all';

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">{isEdit ? 'Edit Download Client' : 'Add Download Client'}</h3>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="clientName" className="block text-sm font-medium mb-2">Name</label>
          <input id="clientName" type="text" {...register('name')} className={`${inputClass} ${errors.name ? 'border-destructive' : ''}`} placeholder="qBittorrent" />
          {errors.name && <p className="text-sm text-destructive mt-1">{errors.name.message}</p>}
        </div>
        <div>
          <label htmlFor="clientType" className="block text-sm font-medium mb-2">Type</label>
          <select id="clientType" {...register('type')} className={inputClass}>
            {downloadClientTypeSchema.options.map((t) => <option key={t} value={t}>{DOWNLOAD_CLIENT_REGISTRY[t]?.label || t}</option>)}
          </select>
        </div>
        {selectedType === 'blackhole'
          ? <BlackholeFields register={register} errors={errors} isEdit={isEdit} />
          : <DownloadClientFields selectedType={selectedType} register={register} errors={errors} clientId={client?.id} setValue={setValue} getValues={getValues} isDirty={isDirty} isEdit={isEdit} />
        }
      </div>
      {!isImplemented && <p className="text-sm text-amber-500">Adapter not yet implemented. Config will be saved for when the adapter is available.</p>}
      {formTestResult && <TestResultMessage success={formTestResult.success} message={formTestResult.message} />}
      <SettingsFormActions isEdit={isEdit} isPending={isPending} testingForm={testingForm} onFormTest={handleSubmit(onFormTest)} onCancel={onCancel} entityLabel="Client" testDisabled={!isImplemented} testDisabledTitle={!isImplemented ? 'Testing available for implemented adapter types' : undefined} />
      {isEdit && client && <RemotePathMappingsSubsection clientId={client.id} />}
    </form>
  );
}
