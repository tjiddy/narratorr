// Does not use useSettingsForm: entity form for indexer CRUD, not a settings category patch.
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Indexer, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { FormField } from './FormField';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { SettingsFormActions } from './SettingsFormActions';
import { SelectWithChevron } from './SelectWithChevron';
import { IndexerFields } from './IndexerFields';
import {
  createIndexerFormSchema,
  indexerTypeSchema,
  type CreateIndexerFormData,
} from '../../../shared/schemas.js';
import {INDEXER_REGISTRY, coerceSearchType, INDEXER_TYPES} from '../../../shared/indexer-registry.js';

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
    useProxy: (s.useProxy as boolean) || false,
    searchLanguages: (s.searchLanguages as number[]) ?? [1],
    searchType: coerceSearchType(s.searchType),
    isVip: s.isVip as boolean | undefined,
    mamUsername: (s.mamUsername as string) || undefined,
    classname: (s.classname as string) || undefined,
  };
}

const defaultValues: CreateIndexerFormData = {
  name: '',
  type: INDEXER_TYPES[0],
  enabled: true,
  priority: 50,
  settings: INDEXER_REGISTRY[INDEXER_TYPES[0]].defaultSettings,
};

function ProwlarrBadge() {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
      Managed by Prowlarr
    </span>
  );
}

function IndexerCardView({ indexer, onEdit, onTest, onDelete, testingId, testResult, animationDelay }: {
  indexer: Indexer;
  onEdit?: () => void;
  onTest?: (id: number) => void;
  onDelete?: () => void;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  animationDelay?: string;
}) {
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
    >
      {indexer.source === 'prowlarr' && <div className="mt-1"><ProwlarrBadge /></div>}
    </SettingsCardShell>
  );
}

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
      setValue('settings', INDEXER_REGISTRY[selectedType]?.defaultSettings || INDEXER_REGISTRY[INDEXER_TYPES[0]].defaultSettings);
    }
  }, [selectedType, mode, setValue]);

  const isImplemented = IMPLEMENTED_TYPES.includes(selectedType);
  const isProwlarrManaged = indexer?.source === 'prowlarr';

  if (mode === 'view' && indexer) {
    return (
      <IndexerCardView
        indexer={indexer}
        onEdit={onEdit}
        onTest={onTest}
        onDelete={onDelete}
        testingId={testingId}
        testResult={testResult}
        animationDelay={animationDelay}
      />
    );
  }

  const isEdit = mode === 'edit';
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <div className="flex items-center gap-3">
        <h3 className="font-display text-lg font-semibold">
          {isEdit ? 'Edit Indexer' : 'Add New Indexer'}
        </h3>
        {isProwlarrManaged && <ProwlarrBadge />}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="indexerName" label="Name" registration={register('name')} error={errors.name} placeholder={INDEXER_REGISTRY[selectedType]?.label} readOnly={isProwlarrManaged} />

        <div>
          <SelectWithChevron id="indexerType" label="Type" {...register('type')} error={!!errors.type}>
            {indexerTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {INDEXER_REGISTRY[t]?.label || t}
              </option>
            ))}
          </SelectWithChevron>
          {selectedType === 'abb' && (
            <p className="text-sm text-muted-foreground mt-1">Large library, but slower and less reliable than other indexers</p>
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
              <label htmlFor="indexerPriority" className="block text-sm font-medium mb-2">Priority</label>
              <input
                id="indexerPriority"
                type="number"
                {...register('priority', { valueAsNumber: true })}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
              />
              <p className="text-sm text-muted-foreground mt-1">Lower values are checked first (1-100)</p>
            </div>
          </>
        )}

        <IndexerFields selectedType={selectedType} register={register} errors={errors} watch={watch} setValue={setValue} prowlarrManaged={isProwlarrManaged} formTestResult={formTestResult} indexerId={indexer?.id} />
      </div>

      {!isImplemented && (
        <p className="text-sm text-amber-500">
          Adapter not yet implemented. Config will be saved for when the adapter is available.
        </p>
      )}

      <div className="min-h-5">
        {formTestResult && (
          <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
        )}
      </div>

      <SettingsFormActions
        isEdit={isEdit}
        isPending={isPending}
        testingForm={testingForm}
        onFormTest={handleSubmit((data) => {
          // In edit mode, include the indexer id for sentinel resolution
          if (indexer?.id) {
            onFormTest({ ...data, id: indexer.id } as CreateIndexerFormData);
          } else {
            onFormTest(data);
          }
        })}
        onCancel={onCancel}
        entityLabel="Indexer"
        testDisabled={!isImplemented}
        testDisabledTitle={!isImplemented ? 'Testing available for implemented adapter types' : undefined}
      />
    </form>
  );
}
