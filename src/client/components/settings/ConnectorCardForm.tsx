import { useEffect, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { api, type TestResult, type ConnectorTarget } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { FormField } from './FormField';
import { SettingsFormActions } from './SettingsFormActions';
import { SelectWithChevron } from './SelectWithChevron';
import { btnSecondary } from './formStyles';
import { CONNECTOR_REGISTRY, type ConnectorType } from '../../../shared/connector-registry.js';
import {
  connectorTypeSchema,
  type CreateConnectorFormData,
} from '../../../shared/schemas.js';

const CONNECTOR_FIELDS = ['baseUrl', 'apiKey', 'libraryId'] as const;
type ConnectorField = typeof CONNECTOR_FIELDS[number];

/** A test/targets failure envelope carries field-scoped errors at runtime. */
type FieldErrorResult = TestResult & { fieldErrors?: Partial<Record<ConnectorField, string>> };

interface ConnectorCardFormProps {
  form: UseFormReturn<CreateConnectorFormData>;
  isEdit: boolean;
  selectedType: ConnectorType;
  editingId?: number | undefined;
  onSubmit: (data: CreateConnectorFormData) => void;
  onFormTest: (data: CreateConnectorFormData) => void;
  onCancel?: (() => void) | undefined;
  isPending?: boolean | undefined;
  testingForm?: boolean | undefined;
  formTestResult?: TestResult | null | undefined;
}

export function ConnectorCardForm(props: ConnectorCardFormProps) {
  const {
    form, isEdit, selectedType, editingId,
    onSubmit, onFormTest, onCancel, isPending, testingForm, formTestResult,
  } = props;
  const { register, handleSubmit, setError, getValues, formState: { errors } } = form;

  const [targets, setTargets] = useState<ConnectorTarget[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // Map a field-scoped envelope onto the NESTED RHF paths (settings.*). A flat
  // setError('apiKey') would NOT highlight the rendered settings.apiKey input.
  function applyFieldErrors(fieldErrors?: Partial<Record<ConnectorField, string>>) {
    if (!fieldErrors) return;
    for (const field of CONNECTOR_FIELDS) {
      const message = fieldErrors[field];
      if (message) setError(`settings.${field}`, { message });
    }
  }

  // Surface field-scoped errors from the server's test result onto the inputs.
  useEffect(() => {
    applyFieldErrors((formTestResult as FieldErrorResult | null | undefined)?.fieldErrors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formTestResult]);

  async function handleFetchLibraries() {
    setFetching(true);
    setFetchError('');
    try {
      const settings = getValues('settings') as Record<string, unknown>;
      const result = await api.fetchConnectorTargets({
        type: selectedType,
        settings,
        ...(editingId !== undefined ? { id: editingId } : {}),
      });
      if (Array.isArray(result)) {
        setTargets(result);
        if (result.length === 0) setFetchError('No libraries found');
      } else {
        setFetchError(result.message || 'Failed to fetch libraries');
        applyFieldErrors((result as FieldErrorResult).fieldErrors);
      }
    } catch {
      setFetchError('Failed to fetch libraries');
    } finally {
      setFetching(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Connector' : 'Add New Connector'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="connectorName" label="Name" registration={register('name')} error={errors.name} placeholder="My Audiobookshelf" />

        <SelectWithChevron id="connectorType" label="Type" {...(isEdit ? { value: selectedType, disabled: true } : register('type'))} error={!!errors.type}>
          {connectorTypeSchema.options.map((t) => (
            <option key={t} value={t}>
              {CONNECTOR_REGISTRY[t]?.label || t}
            </option>
          ))}
        </SelectWithChevron>

        {isEdit && (
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
        )}

        <FormField
          id="connectorBaseUrl"
          label="Server URL"
          type="text"
          className="sm:col-span-2"
          registration={register('settings.baseUrl')}
          error={errors.settings?.baseUrl}
          placeholder="http://audiobookshelf.local:13378"
        />

        <FormField
          id="connectorApiKey"
          label="API Key"
          type="password"
          registration={register('settings.apiKey')}
          error={errors.settings?.apiKey}
          placeholder="API key is required"
        />

        <div>
          <label htmlFor="connectorLibraryId" className="block text-sm font-medium mb-2">Library</label>
          <div className="flex gap-2">
            {targets.length > 0 ? (
              <SelectWithChevron id="connectorLibraryId" {...register('settings.libraryId')} error={!!errors.settings?.libraryId}>
                <option value="">Select a library...</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </SelectWithChevron>
            ) : (
              <input
                id="connectorLibraryId"
                type="text"
                {...register('settings.libraryId')}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
                placeholder="Library ID (or fetch libraries)"
              />
            )}
            <button
              type="button"
              onClick={handleFetchLibraries}
              disabled={fetching}
              className={`${btnSecondary} bg-muted hover:bg-muted/80 whitespace-nowrap`}
            >
              {fetching ? 'Fetching...' : 'Fetch Libraries'}
            </button>
          </div>
          {errors.settings?.libraryId && <p className="text-sm text-destructive mt-1">{errors.settings.libraryId.message}</p>}
          {fetchError && <p className="text-sm text-destructive mt-1">{fetchError}</p>}
        </div>
      </div>

      <div className="min-h-5">
        {formTestResult && (
          <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
        )}
      </div>

      <SettingsFormActions
        isEdit={isEdit}
        isPending={isPending}
        testingForm={testingForm}
        onFormTest={handleSubmit((data) => onFormTest(data))}
        onCancel={onCancel}
        entityLabel="Connector"
      />
    </form>
  );
}
