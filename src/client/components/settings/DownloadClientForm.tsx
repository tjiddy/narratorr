import { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DownloadClient, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { FormField } from './FormField';
import { SettingsFormActions } from './SettingsFormActions';
import { DownloadClientFields } from './DownloadClientFields';
import { BlackholeFields } from './BlackholeFields';
import { SelectWithChevron } from './SelectWithChevron';
import { RemotePathMappingsSubsection } from './RemotePathMappingsSubsection';
import { PathMappingEditor, type PathMappingEntry } from './PathMappingEditor';
import {
  createDownloadClientFormSchema,
  downloadClientTypeSchema,
  type CreateDownloadClientFormData,
} from '../../../shared/schemas.js';
import { DOWNLOAD_CLIENT_REGISTRY, DOWNLOAD_CLIENT_TYPES, settingsFromClient } from '../../../shared/download-client-registry.js';

const IMPLEMENTED_TYPES = Object.keys(DOWNLOAD_CLIENT_REGISTRY);

const defaultValues: CreateDownloadClientFormData = {
  name: '',
  type: DOWNLOAD_CLIENT_TYPES[0],
  enabled: true,
  priority: 50,
  settings: DOWNLOAD_CLIENT_REGISTRY[DOWNLOAD_CLIENT_TYPES[0]].defaultSettings,
};

interface DownloadClientFormProps {
  client?: DownloadClient | undefined;
  mode: 'edit' | 'create';
  onCancel?: (() => void) | undefined;
  onSubmit: (data: CreateDownloadClientFormData & { pathMappings?: PathMappingEntry[] }) => void;
  onFormTest: (data: CreateDownloadClientFormData) => void;
  isPending?: boolean | undefined;
  testingForm?: boolean | undefined;
  formTestResult?: TestResult | null | undefined;
  inModal?: boolean | undefined;
}

export function DownloadClientForm({ client, mode, onCancel, onSubmit, onFormTest, isPending, testingForm, formTestResult, inModal }: DownloadClientFormProps) {
  const isEdit = mode === 'edit';
  const [pathMappings, setPathMappings] = useState<PathMappingEntry[]>([]);
  const {
    register, handleSubmit, reset, watch, setValue, getValues,
    formState: { errors, isDirty },
  } = useForm<CreateDownloadClientFormData>({
    resolver: zodResolver(createDownloadClientFormSchema),
    defaultValues: client
      ? { name: client.name, type: client.type, enabled: client.enabled, priority: client.priority, settings: settingsFromClient(client) }
      : defaultValues,
  });

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = watch('type');

  useEffect(() => {
    if (isEdit && client) {
      reset({ name: client.name, type: client.type, enabled: client.enabled, priority: client.priority, settings: settingsFromClient(client) });
    } else if (!isEdit) {
      reset(defaultValues);
    }
  }, [isEdit, client, reset]);

  useEffect(() => {
    if (!isEdit) setValue('settings', DOWNLOAD_CLIENT_REGISTRY[selectedType]?.defaultSettings || DOWNLOAD_CLIENT_REGISTRY[DOWNLOAD_CLIENT_TYPES[0]].defaultSettings);
  }, [selectedType, isEdit, setValue]);

  const isImplemented = IMPLEMENTED_TYPES.includes(selectedType);

  const handleFormSubmit = useCallback((data: CreateDownloadClientFormData) => {
    if (isEdit) {
      onSubmit(data);
    } else {
      onSubmit({ ...data, pathMappings });
    }
  }, [isEdit, onSubmit, pathMappings]);

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">{isEdit ? 'Edit Download Client' : 'Add Download Client'}</h3>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="clientName" label="Name" registration={register('name')} error={errors.name} placeholder={DOWNLOAD_CLIENT_REGISTRY[selectedType]?.label} />
        <SelectWithChevron id="clientType" label="Type" {...register('type')} error={!!errors.type}>
          {downloadClientTypeSchema.options.map((t) => <option key={t} value={t}>{DOWNLOAD_CLIENT_REGISTRY[t]?.label || t}</option>)}
        </SelectWithChevron>
        {selectedType === 'blackhole'
          ? <BlackholeFields register={register} errors={errors} isEdit={isEdit} />
          : <DownloadClientFields selectedType={selectedType} register={register} errors={errors} clientId={client?.id} setValue={setValue} getValues={getValues} isDirty={isDirty} isEdit={isEdit} inModal={inModal} />
        }
      </div>
      {!isImplemented && <p className="text-sm text-amber-500">Adapter not yet implemented. Config will be saved for when the adapter is available.</p>}
      <div className="min-h-5">
        {formTestResult && <TestResultMessage success={formTestResult.success} message={formTestResult.message} />}
      </div>
      <SettingsFormActions isEdit={isEdit} isPending={isPending} testingForm={testingForm} onFormTest={handleSubmit((data) => onFormTest(data))} onCancel={onCancel} entityLabel="Client" testDisabled={!isImplemented} testDisabledTitle={!isImplemented ? 'Testing available for implemented adapter types' : undefined} />
      {isEdit && client && <RemotePathMappingsSubsection clientId={client.id} />}
      {!isEdit && <PathMappingEditor mappings={pathMappings} onChange={setPathMappings} />}
    </form>
  );
}
