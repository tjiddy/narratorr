import { useEffect, useState } from 'react';
import type { Path, UseFormReturn } from 'react-hook-form';
import { api, type TestResult, type ConnectorTarget } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { FormField } from './FormField';
import { SettingsFormActions } from './SettingsFormActions';
import { SelectWithChevron } from './SelectWithChevron';
import { ConnectorFields } from './ConnectorFields';
import { CONNECTOR_REGISTRY, type ConnectorType } from '../../../shared/connector-registry.js';
import {
  connectorTypeSchema,
  type CreateConnectorFormData,
} from '../../../shared/schemas.js';

/** A test/targets failure envelope carries field-scoped errors at runtime. */
type FieldErrorResult = TestResult & { fieldErrors?: Record<string, string> };

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
  const { register, handleSubmit, setError, getValues, setValue, formState: { errors } } = form;

  // Drop fully-blank path-mapping rows BEFORE zodResolver runs. RHF invokes the
  // resolver inside handleSubmit (before onSubmit), and the form schema now
  // enforces .trim().min(1) on both row fields — so an all-blank appended row
  // would otherwise fail validation and block the submit. Pruning here turns an
  // all-blank set into [] (passthrough-only) while leaving partial rows (one side
  // filled) in place for zodResolver to flag inline beside the missing field.
  function pruneBlankPathMappings() {
    const rows = getValues('settings.pathMappings');
    if (!Array.isArray(rows)) return;
    const pruned = rows.filter(
      (r) => (r?.localPath ?? '').trim() !== '' || (r?.serverPath ?? '').trim() !== '',
    );
    if (pruned.length !== rows.length) {
      setValue('settings.pathMappings', pruned, { shouldValidate: false });
    }
  }

  const [targets, setTargets] = useState<ConnectorTarget[]>([]);
  const [fetchedType, setFetchedType] = useState<ConnectorType | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  // Gate fetched targets/errors to the type they were fetched for so a stale
  // dropdown from one provider can't leak into another after a type switch
  // (derived state — no reset effect needed).
  const visibleTargets = fetchedType === selectedType ? targets : [];
  const visibleFetchError = fetchedType === selectedType ? fetchError : '';

  // Map a field-scoped envelope onto the NESTED RHF paths (settings.*), routed by
  // the registry's declared settings keys. A flat setError('token') would NOT
  // highlight the rendered settings.token input; unknown keys fall back to the
  // form-level test message (already rendered via TestResultMessage).
  function applyFieldErrors(fieldErrors?: Record<string, string>) {
    if (!fieldErrors) return;
    const known = new Set(CONNECTOR_REGISTRY[selectedType]?.settingsFields.map((f) => f.key) ?? []);
    for (const [key, message] of Object.entries(fieldErrors)) {
      if (message && known.has(key)) {
        setError(`settings.${key}` as Path<CreateConnectorFormData>, { message });
      }
    }
  }

  // Surface field-scoped errors from the server's test result onto the inputs.
  useEffect(() => {
    applyFieldErrors((formTestResult as FieldErrorResult | null | undefined)?.fieldErrors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formTestResult]);

  async function handleFetchTargets() {
    setFetching(true);
    setFetchError('');
    setFetchedType(selectedType);
    try {
      const settings = getValues('settings') as Record<string, unknown>;
      const result = await api.fetchConnectorTargets({
        type: selectedType,
        settings,
        ...(editingId !== undefined ? { id: editingId } : {}),
      });
      if (Array.isArray(result)) {
        setTargets(result);
        if (result.length === 0) setFetchError('No options found');
      } else {
        setFetchError(result.message || 'Failed to fetch options');
        applyFieldErrors((result as FieldErrorResult).fieldErrors);
      }
    } catch {
      setFetchError('Failed to fetch options');
    } finally {
      setFetching(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        pruneBlankPathMappings();
        void handleSubmit(onSubmit)(e);
      }}
      className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5"
    >
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

        <ConnectorFields
          form={form}
          selectedType={selectedType}
          targets={visibleTargets}
          fetching={fetching}
          fetchError={visibleFetchError}
          onFetchTargets={handleFetchTargets}
        />
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
        onFormTest={() => {
          pruneBlankPathMappings();
          void handleSubmit((data) => onFormTest(data))();
        }}
        onCancel={onCancel}
        entityLabel="Connector"
      />
    </form>
  );
}
