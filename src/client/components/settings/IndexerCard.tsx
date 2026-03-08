import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Indexer, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { SettingsFormActions } from './SettingsFormActions';
import { IndexerFields } from './IndexerFields';
import {
  createIndexerFormSchema,
  indexerTypeSchema,
  type CreateIndexerFormData,
} from '../../../shared/schemas.js';
import { INDEXER_REGISTRY } from '../../../shared/indexer-registry.js';

const IMPLEMENTED_TYPES = Object.keys(INDEXER_REGISTRY);

interface IndexerCardProps {
  indexer?: Indexer;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: CreateIndexerFormData) => void;
  onFormTest: (data: CreateIndexerFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
}

function settingsFromIndexer(indexer: Indexer): CreateIndexerFormData['settings'] {
  const s = indexer.settings as Record<string, unknown>;
  return {
    hostname: (s.hostname as string) || '',
    pageLimit: (s.pageLimit as number) || 2,
    apiUrl: (s.apiUrl as string) || '',
    apiKey: (s.apiKey as string) || '',
    flareSolverrUrl: (s.flareSolverrUrl as string) || '',
    mamId: (s.mamId as string) || '',
    baseUrl: (s.baseUrl as string) || '',
  };
}

const defaultValues: CreateIndexerFormData = {
  name: '',
  type: 'abb',
  enabled: true,
  priority: 50,
  settings: INDEXER_REGISTRY.abb.defaultSettings,
};

export function IndexerCard(props: IndexerCardProps) {
  const {
    indexer, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest,
    onTest, isPending, testingId, testResult, testingForm, formTestResult, animationDelay,
  } = props;
  const {
    register, handleSubmit, reset, watch, setValue,
    formState: { errors },
  } = useForm<CreateIndexerFormData>({
    resolver: zodResolver(createIndexerFormSchema),
    defaultValues: indexer
      ? {
          name: indexer.name,
          type: indexer.type as CreateIndexerFormData['type'],
          enabled: indexer.enabled,
          priority: indexer.priority,
          settings: settingsFromIndexer(indexer),
        }
      : defaultValues,
  });

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = watch('type');

  useEffect(() => {
    if (mode === 'edit' && indexer) {
      reset({
        name: indexer.name,
        type: indexer.type as CreateIndexerFormData['type'],
        enabled: indexer.enabled,
        priority: indexer.priority,
        settings: settingsFromIndexer(indexer),
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, indexer, reset]);

  useEffect(() => {
    if (mode === 'create') {
      setValue('settings', INDEXER_REGISTRY[selectedType]?.defaultSettings || INDEXER_REGISTRY.abb.defaultSettings);
    }
  }, [selectedType, mode, setValue]);

  const isImplemented = IMPLEMENTED_TYPES.includes(selectedType);

  if (mode === 'view' && indexer) {
    return (
      <SettingsCardShell
        name={indexer.name}
        subtitle={INDEXER_REGISTRY[indexer.type]?.viewSubtitle(indexer.settings as Record<string, unknown>) || indexer.type}
        enabled={indexer.enabled}
        itemId={indexer.id}
        onEdit={onEdit}
        onTest={onTest}
        onDelete={onDelete}
        testingId={testingId}
        testResult={testResult}
        testDisabled={!IMPLEMENTED_TYPES.includes(indexer.type)}
        testDisabledTitle={!IMPLEMENTED_TYPES.includes(indexer.type) ? 'Testing available for implemented adapter types' : undefined}
        animationDelay={animationDelay}
      />
    );
  }

  const isEdit = mode === 'edit';
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Indexer' : 'Add New Indexer'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="indexerName" className="block text-sm font-medium mb-2">Name</label>
          <input
            id="indexerName"
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
          <label htmlFor="indexerType" className="block text-sm font-medium mb-2">Type</label>
          <select
            id="indexerType"
            {...register('type')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          >
            {indexerTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {INDEXER_REGISTRY[t]?.label || t}
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
              <label htmlFor="indexerPriority" className="block text-sm font-medium mb-2">Priority</label>
              <input
                id="indexerPriority"
                type="number"
                {...register('priority', { valueAsNumber: true })}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
              <p className="text-sm text-muted-foreground mt-1">Lower values are checked first (1-100)</p>
            </div>
          </>
        )}

        <IndexerFields selectedType={selectedType} register={register} errors={errors} />
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
        entityLabel="Indexer"
        testDisabled={!isImplemented}
        testDisabledTitle={!isImplemented ? 'Testing available for implemented adapter types' : undefined}
      />
    </form>
  );
}
